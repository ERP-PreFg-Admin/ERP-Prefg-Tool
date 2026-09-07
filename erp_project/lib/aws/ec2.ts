// Instance id → Name tag, so the Infra tab can say "erp-app-prod" instead of
// "i-0a249d3d470e693d3".
//
// Looked up rather than hardcoded: instances get replaced from the launch
// template, and a stale map would confidently mislabel prod as test — worse
// than showing a raw id.

import { EC2Client, DescribeTagsCommand } from "@aws-sdk/client-ec2"
import { AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY } from "@/lib/env"

let _ec2: EC2Client | undefined
function client(): EC2Client {
  if (!_ec2) {
    _ec2 = new EC2Client({
      region: AWS_REGION,
      credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY },
    })
  }
  return _ec2
}

/**
 * Every instance's Name tag, keyed by instance id.
 *
 * DescribeTags, not DescribeInstances: the tag API returns just the pairs we
 * want, where the instance API returns the full reservation graph — block
 * devices, ENIs, security groups — to read one string off each.
 */
export async function getInstanceNames(): Promise<Record<string, string>> {
  const res = await client().send(
    new DescribeTagsCommand({
      Filters: [
        { Name: "resource-type", Values: ["instance"] },
        { Name: "key", Values: ["Name"] },
      ],
    })
  )
  const out: Record<string, string> = {}
  for (const t of res.Tags ?? []) {
    if (t.ResourceId && t.Value) out[t.ResourceId] = t.Value
  }
  return out
}
