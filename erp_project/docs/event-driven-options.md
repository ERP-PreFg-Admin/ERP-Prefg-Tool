> **Related docs:** [Architecture](./architecture.md) · [Architecture Evolution](./architecture-evolution.md) · [Event Catalog](./event-catalog.md)

# Event-Driven Architecture â€” Options & Decision Document

> **Status:** For review Â· **Purpose:** Compare event-backbone options for stakeholder decision Â· **Owner:** Ajay
> **Companion doc:** `docs/architecture-evolution.md` (gateway layer + reference design)

---

## 1. Context

The ERP is today a **synchronous Next.js 16 monolith** on a single MariaDB (AWS RDS), accessed via raw `mysql2` (`lib/db.ts`). All side-effects (audit trail, future approvals, notifications) run inline inside the HTTP request. We want to move to an **event-driven architecture** and add an **API gateway**, integrated into the existing app rather than rewritten.

Two directional decisions are already settled:
- **Evolve the monolith** (not microservices yet).
- **In-app API gateway layer** + **incremental rollout**.

The **open decision** is *which event backbone to use*. We're already on **AWS (RDS)** and plan to use **S3**, which makes AWS-native event services especially relevant. This document lays out every viable option with trade-offs, cost, and operational burden so a decision can be made later with senior stakeholders. It does **not** pick one.

---

## 2. What stays the same regardless of the choice

These are **not** in question â€” they apply to every option below and should be built first:

1. **In-app API Gateway layer** (`lib/gateway/`): one `withGateway()` route wrapper for auth, RBAC (reusing `resolveAccess()` in `lib/permissions.ts`), Zod validation, rate limiting, request-IDs, structured logging, and a uniform error shape. No external service. (Detailed in `docs/architecture-evolution.md` Â§4.)
2. **Service layer** (`lib/services/*`): business logic extracted out of `app/api/v1/masters/*/route.ts` so routes become thin bindings.
3. **Transactional outbox** (`event_outbox` table in RDS): every option that uses a *broker* needs this to avoid the dual-write problem â€” DB commit and event publish are separate systems, so a crash between them loses or duplicates events. The business row and the event row commit in the **same transaction**; a relay then publishes. The only thing that varies per option is *where the relay publishes to*.

The outbox is unnecessary only for the pure in-process option (no second system).

---

## 3. The options

### Option 1 â€” In-process event dispatcher (no infrastructure)
A typed event bus living inside the Next.js process (a `Map` of event-type â†’ handlers). Emitters call `events.emit(...)`; handlers run in the same process.

- **Infra:** none. **Cost:** $0. **Ops:** none. **Local dev:** trivial.
- **Pros:** zero set# Event-Driven Architecture â€” Options & Decision Document

> **Status:** For review Â· **Purpose:** Compare event-backbone options for stakeholder decision Â· **Owner:** Ajay
> **Companion doc:** `docs/architecture-evolution.md` (gateway layer + reference design)

---

## 1. Context

The ERP is today a **synchronous Next.js 16 monolith** on a single MariaDB (AWS RDS), accessed via raw `mysql2` (`lib/db.ts`). All side-effects (audit trail, future approvals, notifications) run inline inside the HTTP request. We want to move to an **event-driven architecture** and add an **API gateway**, integrated into the existing app rather than rewritten.

Two directional decisions are already settled:
- **Evolve the monolith** (not microservices yet).
- **In-app API gateway layer** + **incremental rollout**.

The **open decision** is *which event backbone to use*. We're already on **AWS (RDS)** and plan to use **S3**, which makes AWS-native event services especially relevant. This document lays out every viable option with trade-offs, cost, and operational burden so a decision can be made later with senior stakeholders. It does **not** pick one.

---

## 2. What stays the same regardless of the choice

These are **not** in question â€” they apply to every option below and should be built first:

1. **In-app API Gateway layer** (`lib/gateway/`): one `withGateway()` route wrapper for auth, RBAC (reusing `resolveAccess()` in `lib/permissions.ts`), Zod validation, rate limiting, request-IDs, structured logging, and a uniform error shape. No external service. (Detailed in `docs/architecture-evolution.md` Â§4.)
2. **Service layer** (`lib/services/*`): business logic extracted out of `app/api/v1/masters/*/route.ts` so routes become thin bindings.
3. **Transactional outbox** (`event_outbox` table in RDS): every option that uses a *broker* needs this to avoid the dual-write problem â€” DB commit and event publish are separate systems, so a crash between them loses or duplicates events. The business row and the event row commit in the **same transaction**; a relay then publishes. The only thing that varies per option is *where the relay publishes to*.

The outbox is unnecessary only for the pure in-process option (no second system).

---

## 3. The options

### Option 1 â€” In-process event dispatcher (no infrastructure)
A typed event bus living inside the Next.js process (a `Map` of event-type â†’ handlers). Emitters call `events.emit(...)`; handlers run in the same process.

- **Infra:** none. **Cost:** $0. **Ops:** none. **Local dev:** trivial.
- **Pros:** zero setup, fastest to ship, full decoupling of *code* even without infra.
- **Cons:** handlers run **inside the request** (slow handler = slow response); **no durability** (process restart loses in-flight events); no retries; breaks once the app runs on >1 instance.
- **Best when:** you want the event-driven *code structure* now and will pick real infra later. Designed to swap to any option below via a stable `EventBus` interface.

### Option 2 â€” Amazon EventBridge + SQS (+ Lambda) â€” AWS-native serverless  â­ AWS alternative
EventBridge is a serverless event bus with content-based routing rules to targets (SQS, Lambda, SNS, Step Functions). The outbox relay calls EventBridge `PutEvents`; rules route by event `type` to per-consumer **SQS** queues; handlers run on **Lambda** or a worker polling SQS.

```
service â†’ RDS txn (business row + event_outbox row) â†’ commit
            â†“
   relay reads outbox â†’ EventBridge PutEvents
            â†“
   EventBridge rules (match on event "type")
       â”œâ”€â–º SQS: audit queue         â†’ Lambda/worker â†’ audit handler
       â”œâ”€â–º SQS: approvals queue      â†’ Lambda/worker â†’ approvals handler
       â””â”€â–º SQS: notifications queue  â†’ Lambda â†’ email/WhatsApp
   (S3 object-created events can feed the SAME bus)
```

- **Infra:** fully managed AWS. **Cost:** ~cents/month at ERP volume (EventBridge $1/M events, SQS $0.40/M requests, Lambda effectively free in free tier).
- **Ops:** low â€” no servers; you manage IAM roles, rules, and queues (ideally via IaC).
- **Local dev:** via LocalStack or AWS SAM (some friction vs. a plain process).
- **Pros:** no broker to run; **native S3 integration** (planned S3 uploads flow through the same bus); archive + replay feature; DLQ via SQS; scales to zero.
- **Cons:** not a durable commit log like Kafka (replay is feature-based, not arbitrary re-consumption); default ordering not guaranteed (use **SQS FIFO** if strict per-entity order is needed); more AWS surface area (IAM/rules/queues).
- **Best when:** you want AWS-native, serverless, lowest cost/ops, and already live in AWS (RDS + S3). **Strong fit for this project's stage.**

### Option 3 â€” Amazon SNS + SQS â€” simpler AWS pub/sub  â­ AWS alternative
SNS topic per domain fans out to subscribing SQS queues; handlers poll SQS or trigger Lambda. Like Option 2 but without EventBridge's pattern routing/replay/S3-event integration.

- **Infra:** managed AWS. **Cost:** negligible (SNS $0.50/M, SQS $0.40/M). **Ops:** low. **Local dev:** LocalStack.
- **Pros:** very cheap, simple, durable via SQS, DLQ support, FIFO option.
- **Cons:** no content-based routing (subscription filters are coarser than EventBridge rules); no built-in archive/replay; no native S3-event bus story.
- **Best when:** you want AWS-native and dead simple, and don't need EventBridge's routing/replay.

### Option 4 â€” Amazon MSK (managed Apache Kafka)  â­ AWS alternative
AWS-run Kafka brokers (or **MSK Serverless**). Keeps the full Kafka design from `docs/architecture-evolution.md` (topics, KafkaJS producer/consumer, worker) but AWS manages the brokers.

- **Infra:** managed brokers. **Cost:** meaningful baseline â€” provisioned (~2Ã— `kafka.t3.small`) roughly **$70+/month** plus storage; MSK Serverless has a higher hourly base (hundreds/month) â€” runs 24/7 regardless of volume.
- **Ops:** medium â€” no broker patching, but you still reason about partitions, consumer groups, retention, scaling. **Local dev:** Docker Kafka (KRaft) or Redpanda; identical client code.
- **Pros:** true durable **commit log** with long retention and **arbitrary replay** (rebuild projections/dashboards from history); high throughput; standard, portable (KafkaJS) â€” survives a future microservices split unchanged.
- **Cons:** highest baseline cost; most concepts to learn; overkill at current volume.
- **Best when:** you have (or foresee) high event volume, multiple independent consumers, or a real need to replay full history.

### Option 5 â€” Self-managed Kafka (EC2 / containers)
Same Kafka design, but you run the brokers yourself.

- **Infra:** self-run. **Cost:** EC2 nodes (~$30/mo per node) but **high engineering time**. **Ops:** **high** â€” patching, scaling, disk, monitoring, upgrades all on you.
- **Pros:** full control, lowest raw infra cost.
- **Cons:** ops burden hard to justify for a small team; **not recommended** when MSK exists.
- **Best when:** rarely â€” only with strict control/compliance needs and dedicated ops capacity.

### Option 6 â€” Redis + BullMQ
Durable job queues + pub/sub on Redis (AWS ElastiCache); handlers run in a worker process.

- **Infra:** one Redis instance. **Cost:** ElastiCache `cache.t4g.micro` ~**$12/month**. **Ops:** low-medium. **Local dev:** Docker Redis â€” easy.
- **Pros:** durable, retries, delayed/scheduled jobs, mature DX; cheaper than MSK; good middle ground.
- **Cons:** not AWS-event-native (no S3-event bus integration); replay weaker than Kafka; Redis is also doing cache duty if shared.
- **Best when:** you want durability + background jobs + retries without Kafka cost, and don't need AWS-native routing or S3 integration.

### Option 7 â€” Database outbox + poller only (no broker)
The `event_outbox` table plus a poller that runs handlers directly â€” no message broker at all.

- **Infra:** none beyond existing RDS. **Cost:** $0. **Ops:** minimal. **Local dev:** trivial.
- **Pros:** durable (events persisted in RDS), no new infra, atomic with business writes.
- **Cons:** no fan-out/routing; polling latency; DB carries queue load; doesn't scale to many consumers; you re-implement broker features by hand.
- **Best when:** you want durability with zero new infra as a stepping stone, accepting it's interim.

---

## 4. Comparison at a glance

| Option | New infra | ~Monthly cost (ERP scale) | Ops burden | Durability | Replay | S3-event native | AWS-native | Local dev |
|---|---|---|---|---|---|---|---|---|
| 1. In-process | none | $0 | none | âœ— | âœ— | âœ— | n/a | trivial |
| 2. EventBridge + SQS | managed | ~cents | low | âœ“ | partial (archive) | âœ“ | âœ“ | LocalStack |
| 3. SNS + SQS | managed | ~cents | low | âœ“ | âœ— | âœ— | âœ“ | LocalStack |
| 4. MSK (managed Kafka) | managed | ~$70+ (serverless higher) | medium | âœ“ | âœ“ strong | âœ— | âœ“ | Docker |
| 5. Self-managed Kafka | self-run | ~$30/node + time | high | âœ“ | âœ“ strong | âœ— | partial | Docker |
| 6. Redis + BullMQ | managed | ~$12 | low-med | âœ“ | weak | âœ— | partial | Docker |
| 7. DB outbox + poller | none | $0 | minimal | âœ“ | from table | âœ— | n/a | trivial |

*Costs are rough order-of-magnitude at low ERP event volume; confirm against the AWS pricing calculator for your region (ap-south-1) before deciding.*

---

## 5. Decision criteria (for the stakeholder discussion)

Pick by answering these, not by feature count:

1. **Do we need to replay full event history** (rebuild dashboards/projections from scratch)? â†’ Yes leans **MSK** (Option 4). No â†’ EventBridge/SNS/Redis are enough.
2. **How much AWS ops are we willing to own?** Minimal â†’ **EventBridge/SQS** or **SNS/SQS**. Comfortable with brokers â†’ MSK.
3. **Cost sensitivity at low volume?** EventBridge/SNS/SQS cost cents; MSK runs 24/7 at $70+.
4. **Do we want app events and S3 object events on one bus?** â†’ **EventBridge** uniquely fits.
5. **How important is frictionless local dev?** A long-running worker (`npm run worker`) is identical local/prod; Lambda needs LocalStack/SAM.
6. **Do we foresee splitting into microservices?** Kafka/MSK is the most portable backbone across services; EventBridge also works well as a shared bus.

**Default lean for this project's current stage** (small team, low volume, already on RDS + S3, wants low ops): **Option 2 â€” EventBridge + SQS**, with **Option 1 (in-process)** as a zero-infra starting point that the `EventBus` interface lets us upgrade to any option later. This is a *lean for discussion*, not a committed decision.

---

## 6. Recommended sequencing (independent of the backbone choice)

Because the gateway, service layer, and outbox are constant, work can start now without the backbone decided:

1. **Build the in-app API Gateway layer** (`lib/gateway/*`, Zod) and migrate the SKUs route as the reference. *(No backbone needed.)*
2. **Extract the service layer** and add the **`event_outbox`** table; services write business row + outbox row in one transaction. *(No backbone needed â€” this is Option 7, also a valid interim.)*
3. **Define a stable `EventBus` / relay interface** so the chosen backbone plugs in at one point.
4. **Plug in the chosen backbone** (Option 2/3/4/6) once stakeholders decide â€” only the relay target and the consumer runtime change; routes and services are untouched.

This means the decision can be deferred **without blocking progress**.

---

## 7. Verification (per migrated route, once a backbone is chosen)

1. `npm run build` and `npm run lint` pass; `npm run db:test` green.
2. Functional parity: SKUs page create + bulk import write identical rows in MariaDB.
3. Gateway: unauth â†’ 401; insufficient role â†’ 403; bad payload â†’ 400 (Zod details); over rate-limit â†’ 429; every response carries `x-request-id`.
4. Outbox atomicity: business-write failure leaves **no** orphan outbox row.
5. Delivery (broker options): event published, consumer handler writes audit/approval row shortly after (eventual, not in-request).
6. Resilience: with the backbone unreachable, the request still succeeds and the outbox drains on recovery â€” nothing lost.
7. Idempotency: redelivered message does not double-write (dedupe on `event_id`).
up, fastest to ship, full decoupling of *code* even without infra.
- **Cons:** handlers run **inside the request** (slow handler = slow response); **no durability** (process restart loses in-flight events); no retries; breaks once the app runs on >1 instance.
- **Best when:** you want the event-driven *code structure* now and will pick real infra later. Designed to swap to any option below via a stable `EventBus` interface.

### Option 2 â€” Amazon EventBridge + SQS (+ Lambda) â€” AWS-native serverless  â­ AWS alternative
EventBridge is a serverless event bus with content-based routing rules to targets (SQS, Lambda, SNS, Step Functions). The outbox relay calls EventBridge `PutEvents`; rules route by event `type` to per-consumer **SQS** queues; handlers run on **Lambda** or a worker polling SQS.

```
service â†’ RDS txn (business row + event_outbox row) â†’ commit
            â†“
   relay reads outbox â†’ EventBridge PutEvents
            â†“
   EventBridge rules (match on event "type")
       â”œâ”€â–º SQS: audit queue         â†’ Lambda/worker â†’ audit handler
       â”œâ”€â–º SQS: approvals queue      â†’ Lambda/worker â†’ approvals handler
       â””â”€â–º SQS: notifications queue  â†’ Lambda â†’ email/WhatsApp
   (S3 object-created events can feed the SAME bus)
```

- **Infra:** fully managed AWS. **Cost:** ~cents/month at ERP volume (EventBridge $1/M events, SQS $0.40/M requests, Lambda effectively free in free tier).
- **Ops:** low â€” no servers; you manage IAM roles, rules, and queues (ideally via IaC).
- **Local dev:** via LocalStack or AWS SAM (some friction vs. a plain process).
- **Pros:** no broker to run; **native S3 integration** (planned S3 uploads flow through the same bus); archive + replay feature; DLQ via SQS; scales to zero.
- **Cons:** not a durable commit log like Kafka (replay is feature-based, not arbitrary re-consumption); default ordering not guaranteed (use **SQS FIFO** if strict per-entity order is needed); more AWS surface area (IAM/rules/queues).
- **Best when:** you want AWS-native, serverless, lowest cost/ops, and already live in AWS (RDS + S3). **Strong fit for this project's stage.**

### Option 3 â€” Amazon SNS + SQS â€” simpler AWS pub/sub  â­ AWS alternative
SNS topic per domain fans out to subscribing SQS queues; handlers poll SQS or trigger Lambda. Like Option 2 but without EventBridge's pattern routing/replay/S3-event integration.

- **Infra:** managed AWS. **Cost:** negligible (SNS $0.50/M, SQS $0.40/M). **Ops:** low. **Local dev:** LocalStack.
- **Pros:** very cheap, simple, durable via SQS, DLQ support, FIFO option.
- **Cons:** no content-based routing (subscription filters are coarser than EventBridge rules); no built-in archive/replay; no native S3-event bus story.
- **Best when:** you want AWS-native and dead simple, and don't need EventBridge's routing/replay.

### Option 4 â€” Amazon MSK (managed Apache Kafka)  â­ AWS alternative
AWS-run Kafka brokers (or **MSK Serverless**). Keeps the full Kafka design from `docs/architecture-evolution.md` (topics, KafkaJS producer/consumer, worker) but AWS manages the brokers.

- **Infra:** managed brokers. **Cost:** meaningful baseline â€” provisioned (~2Ã— `kafka.t3.small`) roughly **$70+/month** plus storage; MSK Serverless has a higher hourly base (hundreds/month) â€” runs 24/7 regardless of volume.
- **Ops:** medium â€” no broker patching, but you still reason about partitions, consumer groups, retention, scaling. **Local dev:** Docker Kafka (KRaft) or Redpanda; identical client code.
- **Pros:** true durable **commit log** with long retention and **arbitrary replay** (rebuild projections/dashboards from history); high throughput; standard, portable (KafkaJS) â€” survives a future microservices split unchanged.
- **Cons:** highest baseline cost; most concepts to learn; overkill at current volume.
- **Best when:** you have (or foresee) high event volume, multiple independent consumers, or a real need to replay full history.

### Option 5 â€” Self-managed Kafka (EC2 / containers)
Same Kafka design, but you run the brokers yourself.

- **Infra:** self-run. **Cost:** EC2 nodes (~$30/mo per node) but **high engineering time**. **Ops:** **high** â€” patching, scaling, disk, monitoring, upgrades all on you.
- **Pros:** full control, lowest raw infra cost.
- **Cons:** ops burden hard to justify for a small team; **not recommended** when MSK exists.
- **Best when:** rarely â€” only with strict control/compliance needs and dedicated ops capacity.

### Option 6 â€” Redis + BullMQ
Durable job queues + pub/sub on Redis (AWS ElastiCache); handlers run in a worker process.

- **Infra:** one Redis instance. **Cost:** ElastiCache `cache.t4g.micro` ~**$12/month**. **Ops:** low-medium. **Local dev:** Docker Redis â€” easy.
- **Pros:** durable, retries, delayed/scheduled jobs, mature DX; cheaper than MSK; good middle ground.
- **Cons:** not AWS-event-native (no S3-event bus integration); replay weaker than Kafka; Redis is also doing cache duty if shared.
- **Best when:** you want durability + background jobs + retries without Kafka cost, and don't need AWS-native routing or S3 integration.

### Option 7 â€” Database outbox + poller only (no broker)
The `event_outbox` table plus a poller that runs handlers directly â€” no message broker at all.

- **Infra:** none beyond existing RDS. **Cost:** $0. **Ops:** minimal. **Local dev:** trivial.
- **Pros:** durable (events persisted in RDS), no new infra, atomic with business writes.
- **Cons:** no fan-out/routing; polling latency; DB carries queue load; doesn't scale to many consumers; you re-implement broker features by hand.
- **Best when:** you want durability with zero new infra as a stepping stone, accepting it's interim.

---

## 4. Comparison at a glance

| Option | New infra | ~Monthly cost (ERP scale) | Ops burden | Durability | Replay | S3-event native | AWS-native | Local dev |
|---|---|---|---|---|---|---|---|---|
| 1. In-process | none | $0 | none | âœ— | âœ— | âœ— | n/a | trivial |
| 2. EventBridge + SQS | managed | ~cents | low | âœ“ | partial (archive) | âœ“ | âœ“ | LocalStack |
| 3. SNS + SQS | managed | ~cents | low | âœ“ | âœ— | âœ— | âœ“ | LocalStack |
| 4. MSK (managed Kafka) | managed | ~$70+ (serverless higher) | medium | âœ“ | âœ“ strong | âœ— | âœ“ | Docker |
| 5. Self-managed Kafka | self-run | ~$30/node + time | high | âœ“ | âœ“ strong | âœ— | partial | Docker |
| 6. Redis + BullMQ | managed | ~$12 | low-med | âœ“ | weak | âœ— | partial | Docker |
| 7. DB outbox + poller | none | $0 | minimal | âœ“ | from table | âœ— | n/a | trivial |

*Costs are rough order-of-magnitude at low ERP event volume; confirm against the AWS pricing calculator for your region (ap-south-1) before deciding.*

---

## 5. Decision criteria (for the stakeholder discussion)

Pick by answering these, not by feature count:

1. **Do we need to replay full event history** (rebuild dashboards/projections from scratch)? â†’ Yes leans **MSK** (Option 4). No â†’ EventBridge/SNS/Redis are enough.
2. **How much AWS ops are we willing to own?** Minimal â†’ **EventBridge/SQS** or **SNS/SQS**. Comfortable with brokers â†’ MSK.
3. **Cost sensitivity at low volume?** EventBridge/SNS/SQS cost cents; MSK runs 24/7 at $70+.
4. **Do we want app events and S3 object events on one bus?** â†’ **EventBridge** uniquely fits.
5. **How important is frictionless local dev?** A long-running worker (`npm run worker`) is identical local/prod; Lambda needs LocalStack/SAM.
6. **Do we foresee splitting into microservices?** Kafka/MSK is the most portable backbone across services; EventBridge also works well as a shared bus.

**Default lean for this project's current stage** (small team, low volume, already on RDS + S3, wants low ops): **Option 2 â€” EventBridge + SQS**, with **Option 1 (in-process)** as a zero-infra starting point that the `EventBus` interface lets us upgrade to any option later. This is a *lean for discussion*, not a committed decision.

---

## 6. Recommended sequencing (independent of the backbone choice)

Because the gateway, service layer, and outbox are constant, work can start now without the backbone decided:

1. **Build the in-app API Gateway layer** (`lib/gateway/*`, Zod) and migrate the SKUs route as the reference. *(No backbone needed.)*
2. **Extract the service layer** and add the **`event_outbox`** table; services write business row + outbox row in one transaction. *(No backbone needed â€” this is Option 7, also a valid interim.)*
3. **Define a stable `EventBus` / relay interface** so the chosen backbone plugs in at one point.
4. **Plug in the chosen backbone** (Option 2/3/4/6) once stakeholders decide â€” only the relay target and the consumer runtime change; routes and services are untouched.

This means the decision can be deferred **without blocking progress**.

---

## 7. Verification (per migrated route, once a backbone is chosen)

1. `npm run build` and `npm run lint` pass; `npm run db:test` green.
2. Functional parity: SKUs page create + bulk import write identical rows in MariaDB.
3. Gateway: unauth â†’ 401; insufficient role â†’ 403; bad payload â†’ 400 (Zod details); over rate-limit â†’ 429; every response carries `x-request-id`.
4. Outbox atomicity: business-write failure leaves **no** orphan outbox row.
5. Delivery (broker options): event published, consumer handler writes audit/approval row shortly after (eventual, not in-request).
6. Resilience: with the backbone unreachable, the request still succeeds and the outbox drains on recovery â€” nothing lost.
7. Idempotency: redelivered message does not double-write (dedupe on `event_id`).
