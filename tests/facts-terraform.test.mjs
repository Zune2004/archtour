import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { extractFacts } from "../tools/facts.mjs";
import { diffFacts } from "../tools/facts-diff.mjs";
import { discoverFiles } from "../tools/scan.mjs";
import { RECOMMENDED_RULES } from "../tools/rules-recommended.mjs";
import { evaluateRules } from "../tools/rules.mjs";
import {
  isTerraformPlanJson,
  parseTerraformPlanFacts,
  isStatefulType,
  TERRAFORM_RULES
} from "../tools/facts-terraform.mjs";

const CLI = path.resolve("tools/diagram.mjs");

function makePlan(resourceChanges = [], extra = {}) {
  return JSON.stringify({
    format_version: "1.2",
    terraform_version: "1.9.0",
    resource_changes: resourceChanges,
    ...extra
  }, null, 2);
}

// 1. isTerraformPlanJson
test("isTerraformPlanJson accepts valid plan JSON and rejects non-plan JSON", () => {
  const validPlan = makePlan([
    {
      address: "aws_instance.web",
      type: "aws_instance",
      change: { actions: ["create"], after: { instance_type: "t3.micro" } }
    }
  ]);

  assert.equal(isTerraformPlanJson("tfplan.json", validPlan), true);
  assert.equal(isTerraformPlanJson("custom.json", JSON.parse(validPlan)), true);
  assert.equal(isTerraformPlanJson("plan.json", validPlan), true);
  assert.equal(isTerraformPlanJson("sub/path/prod.tfplan.json", validPlan), true);

  // Negative: Non-json extension
  assert.equal(isTerraformPlanJson("tfplan.txt", validPlan), false);

  // Negative: package.json
  const pkgJson = JSON.stringify({ name: "my-package", version: "1.0.0", scripts: { test: "echo 1" } });
  assert.equal(isTerraformPlanJson("package.json", pkgJson), false);

  // Negative: OpenAPI JSON
  const openApiJson = JSON.stringify({ openapi: "3.0.0", info: { title: "API", version: "1.0" }, paths: {} });
  assert.equal(isTerraformPlanJson("openapi.json", openApiJson), false);

  // Negative: plan.json without required shape (never by name alone)
  assert.equal(isTerraformPlanJson("plan.json", "{}"), false);
  assert.equal(isTerraformPlanJson("plan.json", JSON.stringify({ format_version: "1.2" })), false);
  assert.equal(isTerraformPlanJson("tfplan.json", JSON.stringify({ resource_changes: "not-an-array" })), false);
});

// 2. isStatefulType
test("isStatefulType matches stateful resources and rejects stateless", () => {
  const stateful = [
    "aws_db_instance",
    "aws_rds_cluster",
    "google_sql_database_instance",
    "azurerm_mssql_server",
    "azurerm_mssql_database",
    "azurerm_postgresql_server",
    "azurerm_postgresql_flexible_server",
    "azurerm_mysql_server",
    "aws_dynamodb_table",
    "aws_s3_bucket",
    "google_storage_bucket",
    "azurerm_storage_account"
  ];
  for (const t of stateful) {
    assert.equal(isStatefulType(t), true, `Expected ${t} to be stateful`);
  }

  const stateless = [
    "aws_instance",
    "aws_security_group",
    "aws_security_group_rule",
    "aws_subnet",
    "google_compute_instance",
    "azurerm_virtual_machine"
  ];
  for (const t of stateless) {
    assert.equal(isStatefulType(t), false, `Expected ${t} to be non-stateful`);
  }
});

// 3. tf.resource_deleted (positive stateful hard + positive non-stateful warn + near-miss negative)
test("tf.resource_deleted: stateful delete is hard, non-stateful delete is warn, update is not delete", () => {
  // Stateful delete: aws_db_instance
  const statefulDeletePlan = makePlan([
    {
      address: "aws_db_instance.primary",
      type: "aws_db_instance",
      provider_name: "registry.terraform.io/hashicorp/aws",
      change: {
        actions: ["delete"],
        before: { allocated_storage: 20, instance_class: "db.t3.micro" },
        after: null
      }
    }
  ]);
  const facts1 = extractFacts([{ path: "tfplan.json", content: statefulDeletePlan }]);
  const diff1 = diffFacts(extractFacts([]), facts1);
  const delEv1 = diff1.events.find(e => e.type === "tf.resource_deleted");
  assert.ok(delEv1, "tf.resource_deleted event missing for stateful delete");
  assert.match(delEv1.message, /aws_db_instance\.primary/, "message must name address");
  assert.match(delEv1.message, /stateful resource/, "message must have stateful note");
  assert.equal(delEv1.stateful, true);

  const eval1 = evaluateRules(RECOMMENDED_RULES, diff1, extractFacts([]), facts1);
  const hardFinding1 = eval1.findings.find(f => f.ruleId === "tf-stateful-resource-deleted");
  assert.ok(hardFinding1, "tf-stateful-resource-deleted rule did not fire");
  assert.equal(hardFinding1.level, "hard");
  assert.equal(eval1.findings.some(f => f.ruleId === "tf-resource-deleted"), false, "non-stateful rule should not fire for stateful delete");

  // Non-stateful delete: aws_instance
  const statelessDeletePlan = makePlan([
    {
      address: "aws_instance.worker",
      type: "aws_instance",
      provider_name: "registry.terraform.io/hashicorp/aws",
      change: {
        actions: ["delete"],
        before: { instance_type: "t3.micro" },
        after: null
      }
    }
  ]);
  const facts2 = extractFacts([{ path: "tfplan.json", content: statelessDeletePlan }]);
  const diff2 = diffFacts(extractFacts([]), facts2);
  const delEv2 = diff2.events.find(e => e.type === "tf.resource_deleted");
  assert.ok(delEv2, "tf.resource_deleted event missing for non-stateful delete");
  assert.match(delEv2.message, /aws_instance\.worker/);
  assert.equal(delEv2.stateful, false);

  const eval2 = evaluateRules(RECOMMENDED_RULES, diff2, extractFacts([]), facts2);
  const warnFinding2 = eval2.findings.find(f => f.ruleId === "tf-resource-deleted");
  assert.ok(warnFinding2, "tf-resource-deleted rule did not fire");
  assert.equal(warnFinding2.level, "warn");
  assert.equal(eval2.findings.some(f => f.level === "hard"), false, "deletion of non-stateful resource must be warn not hard");

  // Near-miss negative: update / create
  const updatePlan = makePlan([
    {
      address: "aws_db_instance.primary",
      type: "aws_db_instance",
      change: {
        actions: ["update"],
        before: { allocated_storage: 20 },
        after: { allocated_storage: 40 }
      }
    }
  ]);
  const facts3 = extractFacts([{ path: "tfplan.json", content: updatePlan }]);
  const diff3 = diffFacts(extractFacts([]), facts3);
  assert.equal(diff3.events.some(e => e.type === "tf.resource_deleted"), false, "update should not emit tf.resource_deleted");
});

// 4. tf.resource_replaced (stateful soft + non-stateful + near-miss negative)
test("tf.resource_replaced: stateful replace is soft with stateful note; update is not replace", () => {
  // Stateful replace: aws_db_instance
  const statefulReplacePlan = makePlan([
    {
      address: "aws_db_instance.db",
      type: "aws_db_instance",
      change: {
        actions: ["create", "delete"],
        before: { db_name: "mydb" },
        after: { db_name: "newdb" }
      }
    }
  ]);
  const facts1 = extractFacts([{ path: "tfplan.json", content: statefulReplacePlan }]);
  const diff1 = diffFacts(extractFacts([]), facts1);
  const repEv = diff1.events.find(e => e.type === "tf.resource_replaced");
  assert.ok(repEv, "tf.resource_replaced missing for replaced stateful resource");
  assert.match(repEv.message, /aws_db_instance\.db/);
  assert.match(repEv.message, /stateful resource/, "replace message must have stateful note");
  assert.equal(repEv.stateful, true);

  const eval1 = evaluateRules(RECOMMENDED_RULES, diff1, extractFacts([]), facts1);
  const softFinding = eval1.findings.find(f => f.ruleId === "tf-stateful-resource-replaced");
  assert.ok(softFinding, "tf-stateful-resource-replaced did not fire");
  assert.equal(softFinding.level, "soft");

  // Non-stateful replace: aws_instance
  const statelessReplacePlan = makePlan([
    {
      address: "aws_instance.bastion",
      type: "aws_instance",
      change: {
        actions: ["delete", "create"],
        before: { ami: "ami-1" },
        after: { ami: "ami-2" }
      }
    }
  ]);
  const facts2 = extractFacts([{ path: "tfplan.json", content: statelessReplacePlan }]);
  const diff2 = diffFacts(extractFacts([]), facts2);
  const repEv2 = diff2.events.find(e => e.type === "tf.resource_replaced");
  assert.ok(repEv2);
  assert.equal(repEv2.stateful, false);

  const eval2 = evaluateRules(RECOMMENDED_RULES, diff2, extractFacts([]), facts2);
  assert.equal(eval2.findings.some(f => f.ruleId === "tf-stateful-resource-replaced"), false, "non-stateful replace should not trigger soft stateful replace rule");
});

// 5. tf.public_ingress_added (positives across AWS, GCP, Azure + near-miss negatives)
test("tf.public_ingress_added: detects 0.0.0.0/0 and ::/0 on AWS, GCP, Azure; ignores internal CIDRs and pre-existing rules", () => {
  // Positive 1: aws_security_group ingress
  const sgPlan = makePlan([
    {
      address: "aws_security_group.web",
      type: "aws_security_group",
      change: {
        actions: ["create"],
        before: null,
        after: {
          name: "web-sg",
          ingress: [
            { from_port: 80, to_port: 80, protocol: "tcp", cidr_blocks: ["0.0.0.0/0"] }
          ]
        }
      }
    }
  ]);
  const diff1 = diffFacts(extractFacts([]), extractFacts([{ path: "tfplan.json", content: sgPlan }]));
  const ev1 = diff1.events.find(e => e.type === "tf.public_ingress_added");
  assert.ok(ev1, "tf.public_ingress_added missing for aws_security_group 0.0.0.0/0");
  assert.match(ev1.message, /aws_security_group\.web/);

  // Positive 2: aws_security_group_rule
  const sgrPlan = makePlan([
    {
      address: "aws_security_group_rule.allow_ipv6",
      type: "aws_security_group_rule",
      change: {
        actions: ["create"],
        before: null,
        after: {
          type: "ingress",
          ipv6_cidr_blocks: ["::/0"]
        }
      }
    }
  ]);
  const diff2 = diffFacts(extractFacts([]), extractFacts([{ path: "tfplan.json", content: sgrPlan }]));
  assert.ok(diff2.events.some(e => e.type === "tf.public_ingress_added" && e.address === "aws_security_group_rule.allow_ipv6"));

  // Positive 3: aws_vpc_security_group_ingress_rule
  const vpcIngressPlan = makePlan([
    {
      address: "aws_vpc_security_group_ingress_rule.http",
      type: "aws_vpc_security_group_ingress_rule",
      change: {
        actions: ["create"],
        before: null,
        after: {
          cidr_ipv4: "0.0.0.0/0",
          ip_protocol: "tcp",
          from_port: 443,
          to_port: 443
        }
      }
    }
  ]);
  const diff3 = diffFacts(extractFacts([]), extractFacts([{ path: "tfplan.json", content: vpcIngressPlan }]));
  assert.ok(diff3.events.some(e => e.type === "tf.public_ingress_added"));

  // Positive 4: google_compute_firewall
  const gcpFwPlan = makePlan([
    {
      address: "google_compute_firewall.allow_web",
      type: "google_compute_firewall",
      change: {
        actions: ["create"],
        before: null,
        after: {
          direction: "INGRESS",
          source_ranges: ["0.0.0.0/0"]
        }
      }
    }
  ]);
  const diff4 = diffFacts(extractFacts([]), extractFacts([{ path: "tfplan.json", content: gcpFwPlan }]));
  assert.ok(diff4.events.some(e => e.type === "tf.public_ingress_added"));

  // Positive 5: azurerm_network_security_rule (*, Internet, 0.0.0.0/0)
  const azureNsgPlan = makePlan([
    {
      address: "azurerm_network_security_rule.allow_internet",
      type: "azurerm_network_security_rule",
      change: {
        actions: ["create"],
        before: null,
        after: {
          direction: "Inbound",
          source_address_prefix: "Internet"
        }
      }
    }
  ]);
  const diff5 = diffFacts(extractFacts([]), extractFacts([{ path: "tfplan.json", content: azureNsgPlan }]));
  assert.ok(diff5.events.some(e => e.type === "tf.public_ingress_added"));

  // Near-miss negative 1: ingress from internal subnet 10.0.0.0/8
  const internalSgPlan = makePlan([
    {
      address: "aws_security_group.internal",
      type: "aws_security_group",
      change: {
        actions: ["create"],
        before: null,
        after: {
          ingress: [
            { from_port: 80, to_port: 80, cidr_blocks: ["10.0.0.0/8", "192.168.1.0/24"] }
          ]
        }
      }
    }
  ]);
  const diffNeg1 = diffFacts(extractFacts([]), extractFacts([{ path: "tfplan.json", content: internalSgPlan }]));
  assert.equal(diffNeg1.events.some(e => e.type === "tf.public_ingress_added"), false, "10.0.0.0/8 must NOT trigger public ingress");

  // Near-miss negative 2: 0.0.0.0/0 was ALREADY in before (unchanged)
  const existingSgPlan = makePlan([
    {
      address: "aws_security_group.already_open",
      type: "aws_security_group",
      change: {
        actions: ["update"],
        before: {
          ingress: [{ from_port: 80, to_port: 80, cidr_blocks: ["0.0.0.0/0"] }]
        },
        after: {
          ingress: [{ from_port: 80, to_port: 80, cidr_blocks: ["0.0.0.0/0"] }]
        }
      }
    }
  ]);
  const diffNeg2 = diffFacts(extractFacts([]), extractFacts([{ path: "tfplan.json", content: existingSgPlan }]));
  assert.equal(diffNeg2.events.some(e => e.type === "tf.public_ingress_added"), false, "pre-existing 0.0.0.0/0 must NOT trigger public ingress");

  // Near-miss negative 3: egress rule to 0.0.0.0/0
  const egressPlan = makePlan([
    {
      address: "aws_security_group_rule.outbound",
      type: "aws_security_group_rule",
      change: {
        actions: ["create"],
        after: {
          type: "egress",
          cidr_blocks: ["0.0.0.0/0"]
        }
      }
    }
  ]);
  const diffNeg3 = diffFacts(extractFacts([]), extractFacts([{ path: "tfplan.json", content: egressPlan }]));
  assert.equal(diffNeg3.events.some(e => e.type === "tf.public_ingress_added"), false, "egress rule must NOT trigger public ingress");
});

// 6. tf.bucket_public (positives + near-miss negatives)
test("tf.bucket_public: detects public access block flag false or deleted, public ACL, allUsers IAM; rejects private settings", () => {
  // Positive 1: aws_s3_bucket_public_access_block with flag turned false
  const pabPlan = makePlan([
    {
      address: "aws_s3_bucket_public_access_block.pab",
      type: "aws_s3_bucket_public_access_block",
      change: {
        actions: ["update"],
        before: { block_public_acls: true, block_public_policy: true, ignore_public_acls: true, restrict_public_buckets: true },
        after: { block_public_acls: false, block_public_policy: true, ignore_public_acls: true, restrict_public_buckets: true }
      }
    }
  ]);
  const diff1 = diffFacts(extractFacts([]), extractFacts([{ path: "tfplan.json", content: pabPlan }]));
  assert.ok(diff1.events.some(e => e.type === "tf.bucket_public" && e.address === "aws_s3_bucket_public_access_block.pab"));

  // Positive 2: aws_s3_bucket_public_access_block deleted
  const pabDelPlan = makePlan([
    {
      address: "aws_s3_bucket_public_access_block.pab",
      type: "aws_s3_bucket_public_access_block",
      change: {
        actions: ["delete"],
        before: { block_public_acls: true },
        after: null
      }
    }
  ]);
  const diff2 = diffFacts(extractFacts([]), extractFacts([{ path: "tfplan.json", content: pabDelPlan }]));
  assert.ok(diff2.events.some(e => e.type === "tf.bucket_public"));

  // Positive 3: aws_s3_bucket_acl set to public-read
  const aclPlan = makePlan([
    {
      address: "aws_s3_bucket_acl.acl",
      type: "aws_s3_bucket_acl",
      change: {
        actions: ["create"],
        before: null,
        after: { acl: "public-read" }
      }
    }
  ]);
  const diff3 = diffFacts(extractFacts([]), extractFacts([{ path: "tfplan.json", content: aclPlan }]));
  assert.ok(diff3.events.some(e => e.type === "tf.bucket_public"));

  // Positive 4: google_storage_bucket_iam_binding with allUsers
  const gcsIamPlan = makePlan([
    {
      address: "google_storage_bucket_iam_binding.binding",
      type: "google_storage_bucket_iam_binding",
      change: {
        actions: ["create"],
        before: null,
        after: {
          role: "roles/storage.objectViewer",
          members: ["allUsers"]
        }
      }
    }
  ]);
  const diff4 = diffFacts(extractFacts([]), extractFacts([{ path: "tfplan.json", content: gcsIamPlan }]));
  assert.ok(diff4.events.some(e => e.type === "tf.bucket_public"));

  // Near-miss negative 1: public access block with all four flags true
  const safePabPlan = makePlan([
    {
      address: "aws_s3_bucket_public_access_block.safe",
      type: "aws_s3_bucket_public_access_block",
      change: {
        actions: ["create"],
        after: {
          block_public_acls: true,
          block_public_policy: true,
          ignore_public_acls: true,
          restrict_public_buckets: true
        }
      }
    }
  ]);
  const diffNeg1 = diffFacts(extractFacts([]), extractFacts([{ path: "tfplan.json", content: safePabPlan }]));
  assert.equal(diffNeg1.events.some(e => e.type === "tf.bucket_public"), false, "safe PAB must not emit tf.bucket_public");

  // Near-miss negative 2: private ACL
  const privateAclPlan = makePlan([
    {
      address: "aws_s3_bucket_acl.private",
      type: "aws_s3_bucket_acl",
      change: {
        actions: ["create"],
        after: { acl: "private" }
      }
    }
  ]);
  const diffNeg2 = diffFacts(extractFacts([]), extractFacts([{ path: "tfplan.json", content: privateAclPlan }]));
  assert.equal(diffNeg2.events.some(e => e.type === "tf.bucket_public"), false, "private ACL must not emit tf.bucket_public");
});

// 7. tf.encryption_disabled (positive + near-miss negative)
test("tf.encryption_disabled: detects storage_encrypted/encrypted/kms_key_id going from true to false/null; rejects unchanged encryption", () => {
  // Positive: storage_encrypted true -> false
  const encPlan = makePlan([
    {
      address: "aws_db_instance.db",
      type: "aws_db_instance",
      change: {
        actions: ["update"],
        before: { storage_encrypted: true },
        after: { storage_encrypted: false }
      }
    }
  ]);
  const diff1 = diffFacts(extractFacts([]), extractFacts([{ path: "tfplan.json", content: encPlan }]));
  const ev1 = diff1.events.find(e => e.type === "tf.encryption_disabled");
  assert.ok(ev1, "tf.encryption_disabled missing when storage_encrypted becomes false");
  assert.match(ev1.message, /aws_db_instance\.db/);

  // Positive: kms_key_id removed
  const kmsPlan = makePlan([
    {
      address: "aws_s3_bucket.logs",
      type: "aws_s3_bucket",
      change: {
        actions: ["update"],
        before: { kms_key_id: "arn:aws:kms:us-east-1:12345:key/abc" },
        after: { kms_key_id: null }
      }
    }
  ]);
  const diff2 = diffFacts(extractFacts([]), extractFacts([{ path: "tfplan.json", content: kmsPlan }]));
  assert.ok(diff2.events.some(e => e.type === "tf.encryption_disabled"));

  // Near-miss negative 1: storage_encrypted remains true
  const safeEncPlan = makePlan([
    {
      address: "aws_db_instance.db",
      type: "aws_db_instance",
      change: {
        actions: ["update"],
        before: { storage_encrypted: true },
        after: { storage_encrypted: true }
      }
    }
  ]);
  const diffNeg1 = diffFacts(extractFacts([]), extractFacts([{ path: "tfplan.json", content: safeEncPlan }]));
  assert.equal(diffNeg1.events.some(e => e.type === "tf.encryption_disabled"), false);

  // Near-miss negative 2: kms_key_id rotated (key-1 -> key-2)
  const rotateKmsPlan = makePlan([
    {
      address: "aws_s3_bucket.logs",
      type: "aws_s3_bucket",
      change: {
        actions: ["update"],
        before: { kms_key_id: "arn:aws:kms:1" },
        after: { kms_key_id: "arn:aws:kms:2" }
      }
    }
  ]);
  const diffNeg2 = diffFacts(extractFacts([]), extractFacts([{ path: "tfplan.json", content: rotateKmsPlan }]));
  assert.equal(diffNeg2.events.some(e => e.type === "tf.encryption_disabled"), false, "KMS rotation is not disabling encryption");
});

// 8. tf.deletion_protection_disabled (positive + near-miss negative)
test("tf.deletion_protection_disabled: detects true -> false; rejects false -> true or unchanged", () => {
  // Positive: true -> false
  const dpPlan = makePlan([
    {
      address: "aws_db_instance.db",
      type: "aws_db_instance",
      change: {
        actions: ["update"],
        before: { deletion_protection: true },
        after: { deletion_protection: false }
      }
    }
  ]);
  const diff1 = diffFacts(extractFacts([]), extractFacts([{ path: "tfplan.json", content: dpPlan }]));
  const ev1 = diff1.events.find(e => e.type === "tf.deletion_protection_disabled");
  assert.ok(ev1, "tf.deletion_protection_disabled missing when deletion_protection disabled");
  assert.match(ev1.message, /aws_db_instance\.db/);

  // Near-miss negative: false -> true (enabling protection)
  const enableDpPlan = makePlan([
    {
      address: "aws_db_instance.db",
      type: "aws_db_instance",
      change: {
        actions: ["update"],
        before: { deletion_protection: false },
        after: { deletion_protection: true }
      }
    }
  ]);
  const diffNeg1 = diffFacts(extractFacts([]), extractFacts([{ path: "tfplan.json", content: enableDpPlan }]));
  assert.equal(diffNeg1.events.some(e => e.type === "tf.deletion_protection_disabled"), false);
});

// 9. tf.iam_wildcard (positive + near-miss negative)
test("tf.iam_wildcard: detects Action * or Resource * with Effect Allow; tolerates invalid JSON; ignores Deny or scoped actions", () => {
  // Positive 1: Action "*" with Allow
  const policyWildcardAction = makePlan([
    {
      address: "aws_iam_policy.admin",
      type: "aws_iam_policy",
      change: {
        actions: ["create"],
        before: null,
        after: {
          policy: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              { Effect: "Allow", Action: "*", Resource: "arn:aws:s3:::my-bucket" }
            ]
          })
        }
      }
    }
  ]);
  const diff1 = diffFacts(extractFacts([]), extractFacts([{ path: "tfplan.json", content: policyWildcardAction }]));
  const ev1 = diff1.events.find(e => e.type === "tf.iam_wildcard");
  assert.ok(ev1, "tf.iam_wildcard missing for wildcard Action");
  assert.match(ev1.message, /aws_iam_policy\.admin/);

  // Positive 2: Resource "*" with Allow
  const policyWildcardResource = makePlan([
    {
      address: "aws_iam_role_policy.reader",
      type: "aws_iam_role_policy",
      change: {
        actions: ["create"],
        after: {
          policy: JSON.stringify({
            Statement: [
              { Effect: "Allow", Action: "s3:*", Resource: "*" }
            ]
          })
        }
      }
    }
  ]);
  const diff2 = diffFacts(extractFacts([]), extractFacts([{ path: "tfplan.json", content: policyWildcardResource }]));
  assert.ok(diff2.events.some(e => e.type === "tf.iam_wildcard"));
  // Orchestrator 14-11: Resource "*" with specific actions is normal (ec2:Describe*, s3:GetObject) and is not flagged
  const specificOnAll = policyWildcardResource.replace("s3:*", "s3:GetObject");
  assert.notEqual(specificOnAll, policyWildcardResource);
  const diff2b = diffFacts(extractFacts([]), extractFacts([{ path: "tfplan.json", content: specificOnAll }]));
  assert.equal(diff2b.events.some(e => e.type === "tf.iam_wildcard"), false);

  // Near-miss negative 1: Action "*" with Effect "Deny"
  const denyWildcardPolicy = makePlan([
    {
      address: "aws_iam_policy.deny_all",
      type: "aws_iam_policy",
      change: {
        actions: ["create"],
        after: {
          policy: JSON.stringify({
            Statement: [
              { Effect: "Deny", Action: "*", Resource: "*" }
            ]
          })
        }
      }
    }
  ]);
  const diffNeg1 = diffFacts(extractFacts([]), extractFacts([{ path: "tfplan.json", content: denyWildcardPolicy }]));
  assert.equal(diffNeg1.events.some(e => e.type === "tf.iam_wildcard"), false, "Deny statement must not trigger tf.iam_wildcard");

  // Near-miss negative 2: Scoped action and resource (s3:GetObject, arn:aws:s3:::bucket/*)
  const scopedPolicy = makePlan([
    {
      address: "aws_iam_policy.scoped",
      type: "aws_iam_policy",
      change: {
        actions: ["create"],
        after: {
          policy: JSON.stringify({
            Statement: [
              { Effect: "Allow", Action: ["s3:GetObject", "s3:ListBucket"], Resource: ["arn:aws:s3:::mybucket/*"] }
            ]
          })
        }
      }
    }
  ]);
  const diffNeg2 = diffFacts(extractFacts([]), extractFacts([{ path: "tfplan.json", content: scopedPolicy }]));
  assert.equal(diffNeg2.events.some(e => e.type === "tf.iam_wildcard"), false, "scoped IAM policy must not trigger tf.iam_wildcard");

  // Near-miss negative 3: Invalid JSON in policy string (tolerated -> no event, no crash)
  const brokenJsonPolicy = makePlan([
    {
      address: "aws_iam_policy.malformed",
      type: "aws_iam_policy",
      change: {
        actions: ["create"],
        after: {
          policy: "{ not valid json"
        }
      }
    }
  ]);
  const diffNeg3 = diffFacts(extractFacts([]), extractFacts([{ path: "tfplan.json", content: brokenJsonPolicy }]));
  assert.equal(diffNeg3.events.some(e => e.type === "tf.iam_wildcard"), false, "malformed policy JSON should not emit event");
});

// 10. Sensitive values never leak into facts, entities, or messages
test("sensitive values are masked to (sensitive) and never appear in facts, entities, or messages", () => {
  const SECRET_1 = "SUPER_SECRET_DATABASE_PW_999";
  const SECRET_2 = "TOP_SECRET_API_KEY_777";

  const sensitivePlan = makePlan([
    {
      address: "aws_db_instance.prod",
      type: "aws_db_instance",
      change: {
        actions: ["create"],
        before: null,
        after: {
          db_name: "proddb",
          password: SECRET_1,
          nested: { token: SECRET_2 }
        },
        after_sensitive: {
          password: true,
          nested: { token: true }
        }
      }
    }
  ]);

  const facts = extractFacts([{ path: "tfplan.json", content: sensitivePlan }]);
  const diff = diffFacts(extractFacts([]), facts);

  const factsStr = JSON.stringify(facts);
  const diffStr = JSON.stringify(diff);

  assert.equal(factsStr.includes(SECRET_1), false, `Sensitive secret 1 leaked in facts: ${factsStr}`);
  assert.equal(factsStr.includes(SECRET_2), false, `Sensitive secret 2 leaked in facts: ${factsStr}`);
  assert.equal(diffStr.includes(SECRET_1), false, `Sensitive secret 1 leaked in diff: ${diffStr}`);
  assert.equal(diffStr.includes(SECRET_2), false, `Sensitive secret 2 leaked in diff: ${diffStr}`);

  // Confirm redacted to "(sensitive)"
  const ent = facts.entities.find(e => e.id === "tf.resource:aws_db_instance.prod");
  assert.ok(ent);
  assert.equal(ent.attrs.after.password, "(sensitive)");
  assert.equal(ent.attrs.after.nested.token, "(sensitive)");
});

// 11. 64 KB JSON capping on before and after values
test("before and after values exceeding 64 KB are capped with truncated: true and values dropped", () => {
  const hugePayload = "x".repeat(70 * 1024);
  const largePlan = makePlan([
    {
      address: "aws_s3_bucket.large",
      type: "aws_s3_bucket",
      change: {
        actions: ["update"],
        before: { small_field: "ok" },
        after: { big_field: hugePayload }
      }
    }
  ]);

  const facts = extractFacts([{ path: "tfplan.json", content: largePlan }]);
  const ent = facts.entities.find(e => e.id === "tf.resource:aws_s3_bucket.large");
  assert.ok(ent);
  assert.deepEqual(ent.attrs.before, { small_field: "ok" });
  assert.deepEqual(ent.attrs.after, { truncated: true });
});

// 12. Candidate detection in discoverFiles: non-plan JSON ignored, 6 MB plan skipped with existing reason
test("discoverFiles: non-plan JSON is not a terraform candidate; 6 MB plan skipped with size limit reason", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tf-scan-test-"));
  try {
    // 1. package.json
    fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "app", version: "1.0.0" }));
    // 2. OpenAPI JSON
    fs.writeFileSync(path.join(tmp, "openapi.json"), JSON.stringify({ openapi: "3.0.0", info: { title: "API", version: "1" }, paths: {} }));
    // 3. Valid plan JSON
    fs.writeFileSync(path.join(tmp, "tfplan.json"), makePlan([{ address: "aws_instance.vm", type: "aws_instance", change: { actions: ["create"] } }]));
    // 4. Large 6 MB plan JSON
    const padding = " ".repeat(6 * 1024 * 1024);
    fs.writeFileSync(path.join(tmp, "huge.tfplan.json"), `{"format_version": "1.2", "resource_changes": []}${padding}`);

    const disc = discoverFiles(tmp);

    // Confirm tfplan.json was discovered as Terraform
    const tfCandidate = disc.files.find(f => f.path === "tfplan.json");
    assert.ok(tfCandidate, "tfplan.json should be discovered");
    assert.equal(tfCandidate.kind, "Terraform");

    // Confirm openapi.json was discovered as API, not Terraform
    const apiCandidate = disc.files.find(f => f.path === "openapi.json");
    assert.ok(apiCandidate, "openapi.json should be discovered as API");
    assert.equal(apiCandidate.kind, "API");

    // Confirm package.json was NOT discovered
    const pkgCandidate = disc.files.find(f => f.path === "package.json");
    assert.equal(pkgCandidate, undefined, "package.json should not be a candidate");

    // Confirm 6 MB plan was skipped with existing size limit reason
    const skippedHuge = disc.skipped.find(s => s.path === "huge.tfplan.json");
    assert.ok(skippedHuge, "6 MB file should be skipped");
    assert.match(skippedHuge.reason, /File size exceeds 5 MB limit/, "must have existing file size limit reason");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// 13. Fail-closed: unparsable plan JSON in head that parsed in base produces parse.error_head
test("unparsable plan JSON in head that parsed in base applies fail-closed path (parse.error_head)", () => {
  const basePlan = makePlan([
    {
      address: "aws_db_instance.db",
      type: "aws_db_instance",
      change: { actions: ["create"], after: { allocated_storage: 20 } }
    }
  ]);
  const headCorruptedPlan = '{"format_version": "1.2", "terraform_version": "1.9.0", "resource_changes": [ CORRUPTED JSON';

  const baseFacts = extractFacts([{ path: "tfplan.json", content: basePlan }]);
  const headFacts = extractFacts([{ path: "tfplan.json", content: headCorruptedPlan }]);

  assert.equal(baseFacts.parseErrors.length, 0);
  assert.ok(headFacts.parseErrors.length > 0, "head must have parseErrors");

  const diff = diffFacts(baseFacts, headFacts);
  const headParseErr = diff.events.find(e => e.type === "parse.error_head");
  assert.ok(headParseErr, "diffFacts must emit parse.error_head when plan parsed in base fails in head");

  const evalResult = evaluateRules(RECOMMENDED_RULES, diff, baseFacts, headFacts);
  const parseRuleFinding = evalResult.findings.find(f => f.ruleId === "parse-error-head");
  assert.ok(parseRuleFinding, "parse-error-head rule must fire");
});

// 14. archtour check end-to-end on two temp dirs with a plan file -> exit 1 for deleted aws_db_instance
test("archtour check end-to-end exits 1 when aws_db_instance is deleted in plan", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tf-e2e-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "tf-e2e-head-"));
  try {
    const basePlan = makePlan([
      {
        address: "aws_db_instance.orders",
        type: "aws_db_instance",
        change: { actions: ["no-op"], after: { allocated_storage: 50 } }
      }
    ]);

    const headPlan = makePlan([
      {
        address: "aws_db_instance.orders",
        type: "aws_db_instance",
        change: { actions: ["delete"], before: { allocated_storage: 50 }, after: null }
      }
    ]);

    fs.writeFileSync(path.join(tmpBase, "tfplan.json"), basePlan);
    fs.writeFileSync(path.join(tmpHead, "tfplan.json"), headPlan);

    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 1, `Expected exit status 1, got ${r.status}. Output: ${r.stdout} Stderr: ${r.stderr}`);

    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 1);
    assert.equal(parsed.verdict, "failed");

    const hardFinding = parsed.findings.find(f => f.level === "hard" && f.event.type === "tf.resource_deleted");
    assert.ok(hardFinding, "Hard finding for deleted stateful resource not found");
    assert.equal(hardFinding.ruleId, "tf-stateful-resource-deleted");
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

test("an app file named plan.json (not a plan) is not a Terraform candidate and is not a parse error", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archtour-tf-name-"));
  try {
    fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ name: "Pro", price: 20, features: ["a"] }));
    fs.writeFileSync(path.join(dir, "tfplan.json"), "{ not json");
    const disc = discoverFiles(dir);
    assert.equal(disc.files.filter(f => f.kind === "Terraform").length, 0);
    const facts = extractFacts(disc.files);
    assert.equal((facts.parseErrors || []).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("values known only after apply are not removals (kms_key_id, deletion_protection)", () => {
  const plan = makePlan([{
    address: "aws_db_instance.main", type: "aws_db_instance",
    change: {
      actions: ["update"],
      before: { kms_key_id: "arn:aws:kms:eu-west-1:111122223333:key/abc", deletion_protection: true, storage_encrypted: true },
      after: { storage_encrypted: true },
      after_unknown: { kms_key_id: true, deletion_protection: true }
    }
  }]);
  const events = diffFacts(extractFacts([]), extractFacts([{ path: "infra/tfplan.json", content: plan }])).events;
  assert.equal(events.filter(e => e.type === "tf.encryption_disabled" || e.type === "tf.deletion_protection_disabled").length, 0);
});
