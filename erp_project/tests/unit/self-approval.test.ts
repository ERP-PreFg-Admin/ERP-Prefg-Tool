import { test } from "node:test"
import assert from "node:assert/strict"
import { mayApproveOwn } from "../../lib/approvals/self-approval"

test("only an Executive-only user is refused self-approval", () => {
  assert.equal(mayApproveOwn(["rm_executive"]), false)
  assert.equal(mayApproveOwn(["rm_executive", "pm_executive"]), false)
  assert.equal(mayApproveOwn(["rm_executive", "pm_lead"]), true)
  assert.equal(mayApproveOwn(["production_head"]), true)
  assert.equal(mayApproveOwn(["admin"]), true)
  assert.equal(mayApproveOwn(["developer"]), true)
  assert.equal(mayApproveOwn([]), false, "no roles is no authority")
})
