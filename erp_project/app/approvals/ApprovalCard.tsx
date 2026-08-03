/** Re-exports the split-up approval-card/ module so existing imports of
 *  "./ApprovalCard" and "@/app/approvals/ApprovalCard" keep working. See
 *  approval-card/ for the actual components — this file is just the
 *  stable public entry point. */
export { default } from "./approval-card/ApprovalCard"
export { ApprovalRow } from "./approval-card/ApprovalRow"
export type { MaterialMap } from "./approval-card/types"
