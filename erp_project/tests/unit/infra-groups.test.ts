// Infra tab: every series and alarm lands under the right box, or under Shared / Other.
import { test } from "node:test"
import assert from "node:assert/strict"
import { BOXES, envForInstance, boxInstanceIds, splitBoxPanels, groupAlarms } from "../../lib/observability/infra-groups"

const TEST_ID = BOXES.test.fallbackId
const PROD_ID = BOXES.prod.fallbackId
const NAMES = { [TEST_ID]: "erp-app-test", [PROD_ID]: "erp-app-prod", "i-0bbbb": "someone-else" }

test("instances classify by Name tag", () => {
  assert.equal(envForInstance(TEST_ID, NAMES), "test")
  assert.equal(envForInstance(PROD_ID, NAMES), "prod")
  assert.equal(envForInstance("i-0bbbb", NAMES), null)
  assert.equal(envForInstance(null, NAMES), null)
})

test("the tag wins over the known id, so a retagged box moves", () => {
  assert.equal(envForInstance(TEST_ID, { [TEST_ID]: "erp-app-prod" }), "prod")
  assert.equal(envForInstance("i-0new", { "i-0new": "erp-app-prod" }), "prod")
})

test("a failed tag lookup falls back to the known ids", () => {
  assert.equal(envForInstance(TEST_ID, {}), "test")
  assert.equal(envForInstance(PROD_ID, {}), "prod")
  assert.equal(envForInstance("i-0cccc", {}), null)
  assert.deepEqual(boxInstanceIds({}), { test: [TEST_ID], prod: [PROD_ID] })
  assert.deepEqual(boxInstanceIds({ "i-0new": "erp-app-prod" }), { test: [TEST_ID], prod: ["i-0new"] })
})

test("box panels split into columns, other keeps only non-empty panels", () => {
  const s = (label: string) => ({ label, values: [1] })
  const panels = [
    { id: "cpu", series: [s(`ERP/EC2 ${TEST_ID} / cpu_usage_active`), s(`ERP/EC2 ${PROD_ID} / cpu_usage_active`)] },
    { id: "disk", series: [s(`ERP/EC2 nvme0n1p1 xfs ${PROD_ID} / disk_used_percent`), s("ERP/EC2 i-0bbbb / disk")] },
  ]
  const out = splitBoxPanels(panels, NAMES)
  assert.deepEqual(out.test.map((p) => [p.id, p.series.length]), [["cpu", 1], ["disk", 0]])
  assert.deepEqual(out.prod.map((p) => [p.id, p.series.length]), [["cpu", 1], ["disk", 1]])
  assert.deepEqual(out.other.map((p) => [p.id, p.series.length]), [["disk", 1]])
})

test("alarms go to their box, RDS to shared, the rest to other", () => {
  const a = (name: string, namespace: string | null, dimensions: string | null) => ({ name, namespace, dimensions })
  const out = groupAlarms(
    [
      a("test-cpu", "ERP/EC2", `${TEST_ID}`),
      a("prod-disk", "ERP/EC2", `/, nvme0n1p1, xfs, ${PROD_ID}`),
      a("rds-cpu", "AWS/RDS", "mcaff-dwh"),
      a("stale", "CWAgent", "i-0bbbb"),
      a("bare", null, null),
    ],
    NAMES
  )
  assert.deepEqual(out.test.map((x) => x.name), ["test-cpu"])
  assert.deepEqual(out.prod.map((x) => x.name), ["prod-disk"])
  assert.deepEqual(out.rds.map((x) => x.name), ["rds-cpu"])
  assert.deepEqual(out.other.map((x) => x.name), ["stale", "bare"])
})
