import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

import { extractFacts } from "../tools/facts.mjs";
import { diffFacts } from "../tools/facts-diff.mjs";
import { discoverFiles } from "../tools/scan.mjs";
import { RECOMMENDED_RULES } from "../tools/rules-recommended.mjs";
import { evaluateRules, getExitCode } from "../tools/rules.mjs";

const CLI = path.resolve("tools/diagram.mjs");

// 1. Multi-document YAML parsing
test("extractFacts parses multi-document YAML and ignores unknown kinds", () => {
  const multiDocYaml = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-app
  namespace: prod
spec:
  template:
    spec:
      containers:
        - name: web
          image: nginx:1.21-alpine
---
apiVersion: v1
kind: Service
metadata:
  name: web-svc
  namespace: prod
spec:
  type: ClusterIP
  ports:
    - port: 80
      targetPort: 8080
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web-ing
  namespace: prod
spec:
  rules:
    - host: web.example.com
  tls:
    - hosts:
        - web.example.com
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: web-config
  namespace: prod
data:
  APP_ENV: production
`;

  const facts = extractFacts([{ path: "manifests.yaml", content: multiDocYaml }]);

  assert.equal(facts.errors.length, 0);
  assert.equal(facts.sources.length, 1);
  assert.equal(facts.sources[0].kind, "Kubernetes");

  // Workload
  const workload = facts.entities.find(e => e.id === "Deployment/prod/web-app");
  assert.ok(workload, "Deployment/prod/web-app workload entity not found");
  assert.equal(workload.kind, "k8s.workload");
  assert.equal(workload.name, "web-app");
  assert.deepEqual(workload.attrs, {
    kind: "Deployment",
    name: "web-app",
    namespace: "prod"
  });

  // Container
  const container = facts.entities.find(e => e.id === "Deployment/prod/web-app/web");
  assert.ok(container, "Deployment/prod/web-app/web container entity not found");
  assert.equal(container.kind, "k8s.container");
  assert.equal(container.attrs.workload, "web-app");
  assert.equal(container.attrs.name, "web");
  assert.equal(container.attrs.image, "nginx:1.21-alpine");
  assert.equal(container.attrs.registry, "docker.io");

  // Service
  const service = facts.entities.find(e => e.id === "Service/prod/web-svc");
  assert.ok(service, "Service/prod/web-svc entity not found");
  assert.equal(service.kind, "k8s.service");
  assert.equal(service.name, "web-svc");
  assert.equal(service.attrs.type, "ClusterIP");
  assert.equal(service.attrs.ports.length, 1);

  // Ingress
  const ingress = facts.entities.find(e => e.id === "Ingress/prod/web-ing");
  assert.ok(ingress, "Ingress/prod/web-ing entity not found");
  assert.equal(ingress.kind, "k8s.ingress");
  assert.equal(ingress.name, "web-ing");
  assert.deepEqual(ingress.attrs.hosts, ["web.example.com"]);
  assert.equal(ingress.attrs.tls, true);

  // Unknown kind ConfigMap ignored
  const configMap = facts.entities.find(e => e.name === "web-config" || (e.id && e.id.includes("ConfigMap")));
  assert.equal(configMap, undefined, "ConfigMap should be ignored as an unknown kind");
});

// 2. Each workload kind incl. CronJob
test("extractFacts extracts each workload kind including CronJob (jobTemplate) and Pod", () => {
  const workloadsYaml = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: dep-1
spec:
  template:
    spec:
      containers:
        - name: dep-c
          image: repo.io/dep:1
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: sts-1
spec:
  template:
    spec:
      containers:
        - name: sts-c
          image: sts:1
---
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: ds-1
spec:
  template:
    spec:
      containers:
        - name: ds-c
          image: ds:1
---
apiVersion: apps/v1
kind: ReplicaSet
metadata:
  name: rs-1
spec:
  template:
    spec:
      containers:
        - name: rs-c
          image: rs:1
---
apiVersion: batch/v1
kind: Job
metadata:
  name: job-1
spec:
  template:
    spec:
      containers:
        - name: job-c
          image: job:1
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: cron-1
spec:
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: cron-c
              image: cron:1
---
apiVersion: v1
kind: Pod
metadata:
  name: pod-1
spec:
  containers:
    - name: pod-c
      image: pod:1
`;

  const facts = extractFacts([{ path: "workloads.yaml", content: workloadsYaml }]);
  assert.equal(facts.errors.length, 0);

  const expectedKinds = [
    ["Deployment", "dep-1", "dep-c"],
    ["StatefulSet", "sts-1", "sts-c"],
    ["DaemonSet", "ds-1", "ds-c"],
    ["ReplicaSet", "rs-1", "rs-c"],
    ["Job", "job-1", "job-c"],
    ["CronJob", "cron-1", "cron-c"],
    ["Pod", "pod-1", "pod-c"]
  ];

  for (const [wKind, wName, cName] of expectedKinds) {
    const wEnt = facts.entities.find(e => e.id === `${wKind}/default/${wName}`);
    assert.ok(wEnt, `Workload entity ${wKind}/default/${wName} not found`);
    assert.equal(wEnt.kind, "k8s.workload");
    assert.equal(wEnt.attrs.kind, wKind);
    assert.equal(wEnt.attrs.name, wName);
    assert.equal(wEnt.attrs.namespace, "default");

    const cEnt = facts.entities.find(e => e.id === `${wKind}/default/${wName}/${cName}`);
    assert.ok(cEnt, `Container entity ${wKind}/default/${wName}/${cName} not found`);
    assert.equal(cEnt.kind, "k8s.container");
    assert.equal(cEnt.attrs.workload, wName);
    assert.equal(cEnt.attrs.name, cName);
  }
});

// 3. Helm template skipped with reason
test("Helm template file containing `{{` is skipped with required reason", () => {
  const helmContent = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "mychart.fullname" . }}
spec:
  template:
    spec:
      containers:
        - name: app
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
`;

  const expectedReason = "Helm template: render with `helm template` and scan the output";

  // Check extractFacts returns skipped error/reason
  const facts = extractFacts([{ path: "chart/templates/deployment.yaml", content: helmContent }]);
  assert.equal(facts.entities.length, 0);
  assert.ok(facts.errors.length > 0, "Expected error or skipped record for Helm file");
  assert.ok(
    facts.errors.some(e => e.message === expectedReason || e.reason === expectedReason),
    `Expected reason "${expectedReason}" in errors`
  );

  // Check discoverFiles skips Helm template
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-test-"));
  try {
    fs.writeFileSync(path.join(tmp, "deployment.yaml"), helmContent);
    const disc = discoverFiles(tmp);
    // Skipped files stay in the list (marked skipped) so `check` can report them as not checked
    assert.ok(disc.files.every((f) => f.skipped === true && f.content === ""));
    assert.ok(
      disc.skipped.some(s => s.reason === expectedReason),
      `Expected skipped reason in discoverFiles: ${expectedReason}`
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// 3b. K8s privileged accepts YAML 1.1 booleans and bare generateName for the workload name
test("K8s privileged accepts YAML 1.1 booleans, ReplicationController is a workload, generateName is used as the name", () => {
  const privilegedYesPod = `
apiVersion: v1
kind: Pod
metadata:
  name: pod-yes
spec:
  containers:
    - name: c
      image: alpine
      securityContext:
        privileged: yes
`;
  const factsYes = extractFacts([{ path: "pod-yes.yaml", content: privilegedYesPod }]);
  const podYes = factsYes.entities.find(e => e.kind === "k8s.container");
  assert.ok(podYes, "pod-yes container not found");
  assert.equal(podYes.attrs.privileged, true, "privileged: yes should be privileged");

  const privilegedRC = `
apiVersion: v1
kind: ReplicationController
metadata:
  name: rc-priv
spec:
  replicas: 1
  template:
    metadata:
      name: rc-pod
    spec:
      containers:
        - name: c
          image: alpine
          securityContext:
            privileged: yes
`;
  const factsRC = extractFacts([{ path: "rc-priv.yaml", content: privilegedRC }]);
  assert.ok(factsRC.errors.length === 0, `ReplicationController parse should have no errors: ${JSON.stringify(factsRC.errors)}`);
  const rcWorkload = factsRC.entities.find(e => e.kind === "k8s.workload" && e.attrs.kind === "ReplicationController");
  assert.ok(rcWorkload, "ReplicationController workload not found");
  assert.equal(rcWorkload.name, "rc-priv");
  const rcEntities = factsRC.entities.filter(e => e.attrs?.workload === "rc-priv");
  const rcContainer = rcEntities.find(e => e.kind === "k8s.container");
  assert.ok(rcContainer, `ReplicationController container not found; rc entities: ${JSON.stringify(rcEntities.map(e => e.id))}`);
  assert.equal(rcContainer.attrs.privileged, true, "ReplicationController privileged: \"yes\" should be privileged");

  const generateNamePod = `
apiVersion: v1
kind: Pod
metadata:
  generateName: web-
spec:
  containers:
    - name: c
      image: alpine
      securityContext:
        privileged: true
`;
  const factsGen = extractFacts([{ path: "pod-gen.yaml", content: generateNamePod }]);
  const genWorkload = factsGen.entities.find(e => e.kind === "k8s.workload");
  assert.ok(genWorkload, "generateName pod workload not found");
  assert.equal(genWorkload.name, "web-");
  const genContainer = factsGen.entities.find(e => e.kind === "k8s.container");
  assert.ok(genContainer, "generateName pod container not found");
  assert.equal(genContainer.attrs.privileged, true);
});

// 4. Secret data never appears in facts (fixture with base64 data)
test("Secret data never appears in extracted facts or diffs", () => {
  const secretKey = "dWx0cmFfc2VjcmV0X3Bhc3N3b3JkXzEyMzQ1"; // base64 for ultra_secret_password_12345
  const secretPlain = "ultra_secret_password_12345";
  const yamlContent = `
apiVersion: v1
kind: Secret
metadata:
  name: db-secret
type: Opaque
data:
  password: ${secretKey}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: db-app
spec:
  template:
    spec:
      containers:
        - name: app
          image: postgres:15
          env:
            - name: DB_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: db-secret
                  key: password
`;

  const facts = extractFacts([{ path: "app.yaml", content: yamlContent }]);
  const serializedFacts = JSON.stringify(facts);

  assert.equal(serializedFacts.includes(secretKey), false, "base64 Secret data leaked in facts");
  assert.equal(serializedFacts.includes(secretPlain), false, "plaintext Secret data leaked in facts");

  const diff = diffFacts({}, facts);
  const serializedDiff = JSON.stringify(diff);
  assert.equal(serializedDiff.includes(secretKey), false, "base64 Secret data leaked in diff");
  assert.equal(serializedDiff.includes(secretPlain), false, "plaintext Secret data leaked in diff");
});

// 5. Env values never appear
test("container environment variable VALUES never appear in facts or diffs", () => {
  const secretApiKey = "super_classified_api_key_999888777";
  const secretDbUri = "postgres://root:classified_password_555@db:5432/main";
  const k8sYaml = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: secure-app
spec:
  template:
    spec:
      containers:
        - name: backend
          image: node:20
          env:
            - name: API_KEY
              value: "${secretApiKey}"
            - name: DATABASE_URL
              value: "${secretDbUri}"
`;

  const facts = extractFacts([{ path: "secure.yaml", content: k8sYaml }]);
  const serializedFacts = JSON.stringify(facts);

  assert.equal(serializedFacts.includes(secretApiKey), false, "API key value leaked in facts");
  assert.equal(serializedFacts.includes(secretDbUri), false, "DB URI value leaked in facts");
  assert.equal(serializedFacts.includes("classified_password_555"), false, "Password leaked in facts");

  const container = facts.entities.find(e => e.id === "Deployment/default/secure-app/backend");
  assert.ok(container);
  assert.deepEqual(container.attrs.envNames, ["API_KEY", "DATABASE_URL"]);

  const diff = diffFacts({}, facts);
  const serializedDiff = JSON.stringify(diff);
  assert.equal(serializedDiff.includes(secretApiKey), false, "API key value leaked in diff");
  assert.equal(serializedDiff.includes(secretDbUri), false, "DB URI value leaked in diff");
});

// 6. Each event type produced from a base/head pair
test("minimal base/head pairs produce each of the specified Kubernetes event types", () => {
  // Helper
  function getDiff(baseYaml, headYaml) {
    const base = extractFacts([{ path: "manifest.yaml", content: baseYaml }]);
    const head = extractFacts([{ path: "manifest.yaml", content: headYaml }]);
    return diffFacts(base, head);
  }

  // 1. k8s.privileged_enabled
  {
    const base = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: app\nspec:\n  template:\n    spec:\n      containers:\n        - name: web\n          image: nginx\n          securityContext:\n            privileged: false\n`;
    const head = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: app\nspec:\n  template:\n    spec:\n      containers:\n        - name: web\n          image: nginx\n          securityContext:\n            privileged: true\n`;
    const diff = getDiff(base, head);
    const ev = diff.events.find(e => e.type === "k8s.privileged_enabled");
    assert.ok(ev, "k8s.privileged_enabled not produced");
    assert.equal(ev.before, false);
    assert.equal(ev.after, true);
  }

  // 2. k8s.privilege_escalation_allowed
  {
    const base = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: app\nspec:\n  template:\n    spec:\n      containers:\n        - name: web\n          image: nginx\n          securityContext:\n            allowPrivilegeEscalation: false\n`;
    const head = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: app\nspec:\n  template:\n    spec:\n      containers:\n        - name: web\n          image: nginx\n          securityContext:\n            allowPrivilegeEscalation: true\n`;
    const diff = getDiff(base, head);
    const ev = diff.events.find(e => e.type === "k8s.privilege_escalation_allowed");
    assert.ok(ev, "k8s.privilege_escalation_allowed not produced");
    assert.equal(ev.after, true);
  }

  // 3. k8s.run_as_root (runAsNonRoot false newly set)
  {
    const base = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: app\nspec:\n  template:\n    spec:\n      containers:\n        - name: web\n          image: nginx\n          securityContext:\n            runAsNonRoot: true\n`;
    const head = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: app\nspec:\n  template:\n    spec:\n      containers:\n        - name: web\n          image: nginx\n          securityContext:\n            runAsNonRoot: false\n`;
    const diff = getDiff(base, head);
    const ev = diff.events.find(e => e.type === "k8s.run_as_root");
    assert.ok(ev, "k8s.run_as_root (runAsNonRoot false) not produced");
  }

  // 3b. k8s.run_as_root (runAsUser 0 newly set)
  {
    const base = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: app\nspec:\n  template:\n    spec:\n      containers:\n        - name: web\n          image: nginx\n          securityContext:\n            runAsUser: 1000\n`;
    const head = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: app\nspec:\n  template:\n    spec:\n      containers:\n        - name: web\n          image: nginx\n          securityContext:\n            runAsUser: 0\n`;
    const diff = getDiff(base, head);
    const ev = diff.events.find(e => e.type === "k8s.run_as_root");
    assert.ok(ev, "k8s.run_as_root (runAsUser 0) not produced");
  }

  // 4. k8s.host_network_enabled
  {
    const base = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: app\nspec:\n  template:\n    spec:\n      hostNetwork: false\n      containers:\n        - name: web\n          image: nginx\n`;
    const head = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: app\nspec:\n  template:\n    spec:\n      hostNetwork: true\n      containers:\n        - name: web\n          image: nginx\n`;
    const diff = getDiff(base, head);
    const ev = diff.events.find(e => e.type === "k8s.host_network_enabled");
    assert.ok(ev, "k8s.host_network_enabled not produced");
    assert.equal(ev.after, true);
  }

  // 5. k8s.host_pid_enabled
  {
    const base = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: app\nspec:\n  template:\n    spec:\n      hostPID: false\n      containers:\n        - name: web\n          image: nginx\n`;
    const head = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: app\nspec:\n  template:\n    spec:\n      hostPID: true\n      containers:\n        - name: web\n          image: nginx\n`;
    const diff = getDiff(base, head);
    const ev = diff.events.find(e => e.type === "k8s.host_pid_enabled");
    assert.ok(ev, "k8s.host_pid_enabled not produced");
    assert.equal(ev.after, true);
  }

  // 6. k8s.host_path_added
  {
    const base = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: app\nspec:\n  template:\n    spec:\n      containers:\n        - name: web\n          image: nginx\n`;
    const head = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: app\nspec:\n  template:\n    spec:\n      volumes:\n        - name: hp\n          hostPath:\n            path: /var/run/docker.sock\n      containers:\n        - name: web\n          image: nginx\n          volumeMounts:\n            - name: hp\n              mountPath: /var/run/docker.sock\n`;
    const diff = getDiff(base, head);
    const ev = diff.events.find(e => e.type === "k8s.host_path_added");
    assert.ok(ev, "k8s.host_path_added not produced");
    assert.equal(ev.after, "/var/run/docker.sock");
  }

  // 7. k8s.capability_added
  {
    const base = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: app\nspec:\n  template:\n    spec:\n      containers:\n        - name: web\n          image: nginx\n`;
    const head = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: app\nspec:\n  template:\n    spec:\n      containers:\n        - name: web\n          image: nginx\n          securityContext:\n            capabilities:\n              add: ["SYS_ADMIN"]\n`;
    const diff = getDiff(base, head);
    const ev = diff.events.find(e => e.type === "k8s.capability_added");
    assert.ok(ev, "k8s.capability_added not produced");
    assert.equal(ev.after, "SYS_ADMIN");
  }

  // 8. k8s.limits_removed
  {
    const base = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: app\nspec:\n  template:\n    spec:\n      containers:\n        - name: web\n          image: nginx\n          resources:\n            limits:\n              cpu: "500m"\n              memory: "256Mi"\n`;
    const head = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: app\nspec:\n  template:\n    spec:\n      containers:\n        - name: web\n          image: nginx\n`;
    const diff = getDiff(base, head);
    const ev = diff.events.find(e => e.type === "k8s.limits_removed");
    assert.ok(ev, "k8s.limits_removed not produced");
  }

  // 9. k8s.limits_missing_new
  {
    const base = ``;
    const head = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: app\nspec:\n  template:\n    spec:\n      containers:\n        - name: web\n          image: nginx\n`;
    const diff = getDiff(base, head);
    const ev = diff.events.find(e => e.type === "k8s.limits_missing_new");
    assert.ok(ev, "k8s.limits_missing_new not produced for new container without limits");
  }

  // 10. k8s.image_changed
  {
    const base = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: app\nspec:\n  template:\n    spec:\n      containers:\n        - name: web\n          image: nginx:1.20\n`;
    const head = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: app\nspec:\n  template:\n    spec:\n      containers:\n        - name: web\n          image: nginx:1.21\n`;
    const diff = getDiff(base, head);
    const ev = diff.events.find(e => e.type === "k8s.image_changed");
    assert.ok(ev, "k8s.image_changed not produced");
    assert.equal(ev.before, "nginx:1.20");
    assert.equal(ev.after, "nginx:1.21");
  }

  // 11. k8s.registry_changed
  {
    const base = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: app\nspec:\n  template:\n    spec:\n      containers:\n        - name: web\n          image: nginx:1.20\n`;
    const head = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: app\nspec:\n  template:\n    spec:\n      containers:\n        - name: web\n          image: ghcr.io/myorg/nginx:1.20\n`;
    const diff = getDiff(base, head);
    const ev = diff.events.find(e => e.type === "k8s.registry_changed");
    assert.ok(ev, "k8s.registry_changed not produced");
    assert.equal(ev.before, "docker.io");
    assert.equal(ev.after, "ghcr.io");
  }

  // 12. k8s.service_exposed
  {
    const base = `apiVersion: v1\nkind: Service\nmetadata:\n  name: my-svc\nspec:\n  type: ClusterIP\n  ports:\n    - port: 80\n`;
    const head = `apiVersion: v1\nkind: Service\nmetadata:\n  name: my-svc\nspec:\n  type: LoadBalancer\n  ports:\n    - port: 80\n`;
    const diff = getDiff(base, head);
    const ev = diff.events.find(e => e.type === "k8s.service_exposed");
    assert.ok(ev, "k8s.service_exposed not produced");
    assert.equal(ev.before, "ClusterIP");
    assert.equal(ev.after, "LoadBalancer");
  }

  // 13. k8s.ingress_host_added
  {
    const base = `apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: my-ing\nspec:\n  rules:\n    - host: api.example.com\n`;
    const head = `apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: my-ing\nspec:\n  rules:\n    - host: api.example.com\n    - host: admin.example.com\n`;
    const diff = getDiff(base, head);
    const ev = diff.events.find(e => e.type === "k8s.ingress_host_added");
    assert.ok(ev, "k8s.ingress_host_added not produced");
    assert.equal(ev.after, "admin.example.com");
  }

  // 14. k8s.ingress_tls_removed
  {
    const base = `apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: my-ing\nspec:\n  tls:\n    - hosts:\n        - api.example.com\n`;
    const head = `apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: my-ing\nspec:\n  rules:\n    - host: api.example.com\n`;
    const diff = getDiff(base, head);
    const ev = diff.events.find(e => e.type === "k8s.ingress_tls_removed");
    assert.ok(ev, "k8s.ingress_tls_removed not produced");
    assert.equal(ev.before, true);
    assert.equal(ev.after, false);
  }

  // 15. entity.added & entity.removed for workloads/services/ingresses
  {
    const base = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: old-app\nspec:\n  template:\n    spec:\n      containers:\n        - name: app\n          image: nginx\n`;
    const head = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: new-app\nspec:\n  template:\n    spec:\n      containers:\n        - name: app\n          image: nginx\n`;
    const diff = getDiff(base, head);
    assert.ok(diff.events.some(e => e.type === "entity.added" && e.entityId === "Deployment/default/new-app"), "entity.added not produced for workload");
    assert.ok(diff.events.some(e => e.type === "entity.removed" && e.entityId === "Deployment/default/old-app"), "entity.removed not produced for workload");
  }
});

// 7. A 2,000-manifest set extracts in < 2 s
test("a 2,000-manifest set extracts in < 2 s", () => {
  const manifests = [];
  for (let i = 0; i < 2000; i++) {
    manifests.push(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-${i}
  namespace: ns-${i % 5}
spec:
  template:
    spec:
      containers:
        - name: c1
          image: nginx:1.20
          resources:
            limits:
              cpu: "100m"
              memory: "128Mi"`);
  }
  const largeYaml = manifests.join("\n---\n");

  const t0 = performance.now();
  const facts = extractFacts([{ path: "manifests-2k.yaml", content: largeYaml }]);
  const t1 = performance.now();
  const elapsedMs = t1 - t0;

  assert.ok(elapsedMs < 2000, `Expected 2,000 manifests extract in < 2000 ms, took ${elapsedMs.toFixed(1)} ms`);
  // 2,000 workloads + 2,000 containers = 4,000 entities
  assert.equal(facts.entities.length, 4000, `Expected 4000 entities, got ${facts.entities.length}`);
  assert.equal(facts.errors.length, 0);
});

// 8. `archtour check` blocks a privileged container in a Deployment (exit 1)
test("archtour check blocks a privileged container in a Deployment (exit 1)", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-k8s-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "check-k8s-head-"));
  try {
    fs.writeFileSync(
      path.join(tmpBase, "deployment.yaml"),
      `apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
  namespace: default
spec:
  template:
    spec:
      containers:
        - name: payment
          image: myorg/payment:1.0
          securityContext:
            privileged: false
`
    );

    fs.writeFileSync(
      path.join(tmpHead, "deployment.yaml"),
      `apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
  namespace: default
spec:
  template:
    spec:
      containers:
        - name: payment
          image: myorg/payment:1.0
          securityContext:
            privileged: true
`
    );

    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 1, `Expected exit status 1, got ${r.status}. Stderr: ${r.stderr}`);

    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 1);
    assert.equal(parsed.verdict, "failed");

    const hardFinding = parsed.findings.find(f => f.level === "hard" && f.event.type === "k8s.privileged_enabled");
    assert.ok(hardFinding, "Hard finding for k8s.privileged_enabled not found");
    assert.ok(hardFinding.ruleId.includes("privileged"), "Rule id should indicate privileged container restriction");
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

test("k8s run-as-root wording: unset vs explicit false vs runAsUser 0 vs a non-root uid", () => {
  const dep = (sc) => ({ path: "k8s/app.yaml", content: [
    "apiVersion: apps/v1", "kind: Deployment", "metadata:", "  name: app", "spec:", "  template:", "    spec:", "      containers:",
    "        - name: web", "          image: ghcr.io/acme/web:1", ...(sc ? ["          securityContext:", ...sc.map(l => "            " + l)] : [])
  ].join("\n") + "\n" });
  const root = (sc) => diffFacts(extractFacts([]), extractFacts([dep(sc)])).events.filter(e => e.type === "k8s.run_as_root");
  assert.match(root(null)[0].message, /does not set runAsNonRoot/);
  assert.equal(root(null)[0].after, "runAsNonRoot: not set");
  assert.match(root(["runAsNonRoot: false"])[0].message, /sets runAsNonRoot: false/);
  assert.match(root(["runAsUser: 0"])[0].message, /runs as root \(runAsUser: 0\)/);
  assert.equal(root(["runAsUser: 1000"]).length, 0, "a non-root uid is not root");
  assert.equal(root(["runAsNonRoot: true"]).length, 0);

  const changed = diffFacts(extractFacts([dep(["runAsNonRoot: true"])]), extractFacts([dep(null)])).events.filter(e => e.type === "k8s.run_as_root");
  assert.equal(changed.length, 1);
  assert.match(changed[0].message, /no longer sets runAsNonRoot/);
  const toUid = diffFacts(extractFacts([dep(["runAsNonRoot: true"])]), extractFacts([dep(["runAsUser: 1000"])])).events.filter(e => e.type === "k8s.run_as_root");
  assert.equal(toUid.length, 0, "dropping runAsNonRoot while setting a non-root uid is not root");
});
