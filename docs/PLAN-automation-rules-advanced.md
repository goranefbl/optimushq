# Automation Rules (Advanced) - Implementation Plan

## Overview
Advanced order automation with condition-based rule engine. All conditions within a rule use AND logic. For OR logic, use multi-value operators like "is one of". Rules execute in priority order. Actions include tag application, custom field setting, and status change triggers.

## Key Constraints
- **All conditions within a rule must be true (AND logic)**
- **Priority-based execution** — earlier rules execute first, later rules can override
- **Org & store-scoped** — rules can apply globally or to specific stores
- **Deterministic** — same order evaluated against same rules always produces same result
- **Single-pass evaluation** — no loops, no dynamic re-triggering
- **No manual override blocking** — automation doesn't prevent manual changes; manual actions take precedence

## Trigger Types
Rules only execute on specific events, preventing redundant re-execution:
- **`on_create`** (default) — fires when order is first synced/created
- **`on_update`** — fires when order details change (items, amount, etc.)
- **`on_status_change`** — fires ONLY when WC status changes
- **`always`** — fires on any order event (create, update, status change)

This prevents rules like "order status = processing → add tag" from firing repeatedly every webhook.

## Reference Tracking
`referencedTagIds` and `referencedFieldKeys` are denormalized on the rule for:
1. **Efficient deletion warnings** — when a tag or custom field is deleted, quickly find all rules referencing it and warn the user
2. **Impact analysis** — see which rules would break if a tag/field is removed
3. **Performance** — avoid scanning all rule JSON configs on every deletion

These arrays are auto-computed and updated whenever a rule is created/modified.

## Condition Types

### Order-Level Conditions
- **Order Status** — `is`, `is not`, `is one of`, `is not one of` (WC status slugs)
- **Order Amount** — `is equal to`, `is greater than`, `is less than`, `is between` (decimal value)
- **Order Item Count** — `equals`, `greater than`, `less than` (integer)
- **Order Country** — `is`, `is not`, `is one of`, `is not one of` (ISO country codes)
- **Order Currency** — `is`, `is not`, `is one of`, `is not one of`
- **Order Has Tag** — `has`, `does not have`, `has any of`, `has all of` (tag names)
- **Custom Field Value** — `equals`, `contains`, `is one of`, `is empty` (type-dependent)

### Item-Level Conditions (Match if ANY item matches)
- **Product SKU** — `is`, `is not`, `contains`, `is one of`
- **Product Category** — `is`, `is not`, `is one of`
- **Product Has Tag** — `has`, `does not have`

## Actions

All actions execute if rule conditions match (all execute, no branching):
- **Add Tag** — apply tag(s) to the order
- **Set Custom Field** — set value on order's custom field
- **Change Order Status** — push new WC status back to store (respects store settings)
- **Create Task** — create internal task for team (future: Slack notification, etc.)

## Data Model

```prisma
model AutomationRule {
  id                 String    @id @default(cuid())
  organizationId     String
  storeId            String?   // null = all stores in org
  name               String
  description        String?
  enabled            Boolean   @default(true)
  priority           Int       @default(0)      // lower = earlier execution
  trigger            String    @default("on_create")  // on_create, on_update, on_status_change, always

  // Conditions: array of condition objects
  conditions         Json      // ConditionGroup[]

  // Actions: array of action objects
  actions            Json      // Action[]

  // Denormalized references for efficient deletion warnings
  referencedTagIds   String[]  @default([])     // tag IDs used in actions
  referencedFieldKeys String[] @default([])     // custom field keys used in conditions/actions

  // Tracking
  createdAt          DateTime  @default(now())
  updatedAt          DateTime  @updatedAt
  createdBy          String

  organization       Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  store              Store?        @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@index([organizationId])
  @@index([storeId])
  @@index([organizationId, priority])
  @@index([enabled])
  @@index([trigger])
}

model AutomationLog {
  id                 String    @id @default(cuid())
  organizationId     String
  orderId            String
  automationRuleId   String
  triggered          Boolean   @default(false)  // did conditions match?
  actionsExecuted    Json      // array of executed actions with results
  executionReason    String?   // why did it trigger (or not)
  createdAt          DateTime  @default(now())

  organization       Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  order              Order         @relation(fields: [orderId], references: [id], onDelete: Cascade)
  automationRule     AutomationRule @relation(fields: [automationRuleId], references: [id], onDelete: Cascade)

  @@index([organizationId])
  @@index([orderId])
  @@index([automationRuleId])
  @@index([createdAt])
}
```

## JSON Schema for Conditions

```typescript
type ConditionGroup = {
  type: 'order' | 'item';
  field: string;              // e.g., 'wcStatus', 'amount', 'sku'
  operator: string;           // e.g., 'is', 'is_one_of', 'greater_than'
  value: string | number | string[] | { min: number; max: number };
};

type Action = {
  type: 'add_tag' | 'set_custom_field' | 'change_status' | 'create_task';
  payload: Record<string, any>; // type-specific payload
};
```

### Condition Examples
```json
[
  { "type": "order", "field": "wcStatus", "operator": "is_one_of", "value": ["processing", "on-hold"] },
  { "type": "order", "field": "amount", "operator": "greater_than", "value": 500 },
  { "type": "order", "field": "country", "operator": "is", "value": "US" }
]
```

All three must match for the rule to trigger.

### Action Examples
```json
[
  { "type": "add_tag", "payload": { "tagNames": ["Urgent", "VIP"] } },
  { "type": "set_custom_field", "payload": { "fieldId": "cf_shipping_class", "value": "Express" } }
]
```

## Implementation Files

### New Files
1. **`src/lib/automation-engine.ts`** (150 lines)
   - `buildOrderContext()` — transform WC order into evaluation context
   - `evaluateConditions()` — check if all conditions match
   - `executeActions()` — apply actions (add tags, set fields, push status)
   - `evaluateAndExecuteRule()` — orchestrate per-rule evaluation

2. **`src/api/v1/automation-rules/index.ts`** (200 lines)
   - GET `/automation-rules` — list rules (org & store-scoped)
   - POST `/automation-rules` — create rule
   - PUT `/automation-rules/:id` — update rule
   - DELETE `/automation-rules/:id` — delete rule
   - POST `/automation-rules/test` — test conditions against sample order

3. **`src/api/v1/automation-rules/execute.ts`** (100 lines)
   - Webhook handler for new/updated orders
   - Loads applicable rules (org + store)
   - Evaluates and executes in priority order
   - Logs execution for audit trail

4. **`src/app/settings/automation-rules/page.tsx`** (350 lines)
   - List view with name, store scope, priority, enabled toggle
   - Create/edit dialog with condition builder UI
   - Action builder UI with dropdowns for tags, fields, statuses
   - Test rule modal with sample order JSON input
   - Delete confirmation

5. **`src/app/settings/automation-rules/rule-builder.tsx`** (400 lines)
   - Condition row component with field/operator/value inputs
   - Dynamic operator dropdown based on field type
   - Add/remove condition buttons
   - Action row component with type dropdown + type-specific payload inputs
   - Tag multi-select, custom field select, status select

6. **`src/components/automation-rule-badge.tsx`** (50 lines)
   - Displays which rules matched on order detail view
   - Shows rule name + icon
   - Links to rule editor

### Modified Files
1. **`prisma/schema.prisma`**
   - Add `AutomationRule` model
   - Add indexes for org, store, priority, enabled

2. **`src/api/webhooks/woocommerce/order-created.ts`**
   - After sync completes, call automation engine
   - Log matched rules to order activity

3. **`src/app/orders/[id]/page.tsx`**
   - Add "Automation Rules Matched" card showing which rules executed
   - Display timestamp and action summary

4. **`README.md`**
   - Document automation rules feature with examples

## UI/UX

### Rules List Page
- Table: Name | Store Scope | Priority | Enabled | Actions
- Buttons: Create Rule, Test Rule, Edit, Delete
- Sort by priority (drag-to-reorder coming later)

### Create/Edit Rule Modal
1. **Basic Info** — name, description, store scope, enabled toggle
2. **Conditions Builder** — add/remove conditions, field/operator/value dropdowns
3. **Actions Builder** — add/remove actions, type-specific payload inputs
4. **Preview** — JSON preview of full rule config

### Test Modal
- Paste sample order JSON (or select from recent orders)
- Click "Evaluate"
- Shows each condition result (✓/✗) + reason
- Shows which actions would execute
- Allows dry-run execution

## Execution Flow

1. **Order webhook received** (new or status change)
2. **Build OrderContext** — extract relevant fields for evaluation
3. **Query applicable rules** — org-level + store-level, enabled only, sorted by priority
4. **For each rule (in priority order):**
   - Evaluate all conditions (AND logic)
   - If all match: execute all actions
   - Log rule match to activity feed
5. **Return execution summary** — which rules matched, which actions executed

## Example Rules

### Rule 1: High-Value Orders get VIP Treatment
```json
{
  "name": "High-Value VIP",
  "conditions": [
    { "type": "order", "field": "amount", "operator": "greater_than", "value": 500 }
  ],
  "actions": [
    { "type": "add_tag", "payload": { "tagNames": ["VIP"] } },
    { "type": "set_custom_field", "payload": { "fieldId": "shipping_class", "value": "Express" } }
  ]
}
```

### Rule 2: International Orders
```json
{
  "name": "International Handling",
  "conditions": [
    { "type": "order", "field": "country", "operator": "is_not", "value": "US" },
    { "type": "order", "field": "wcStatus", "operator": "is_one_of", "value": ["processing", "on-hold"] }
  ],
  "actions": [
    { "type": "add_tag", "payload": { "tagNames": ["Needs Customs Form"] } }
  ]
}
```

### Rule 3: Products with Specific SKU
```json
{
  "name": "Fragile Items",
  "conditions": [
    { "type": "item", "field": "sku", "operator": "contains", "value": "GLASS" }
  ],
  "actions": [
    { "type": "add_tag", "payload": { "tagNames": ["Fragile", "Handle with Care"] } }
  ]
}
```

## Future Enhancements
- Rule templates (pre-built rules for common scenarios)
- Execution history & analytics (which rules trigger most often)
- Conditional actions (if A, do X; if B, do Y) — requires rule engine refactor
- Scheduled automation (run rules on a schedule, not just on order event)
- Slack/email notifications as action type
- Drag-to-reorder rules (visual priority builder)

## Testing Strategy

### Unit Tests
- `automation-engine.test.ts` — condition evaluation, action execution
- Test each operator type
- Test AND logic (all must match)
- Test order vs. item conditions
- Test mixed matching (some conditions fail, rule should not execute)

### Integration Tests
- Create rule, sync order from WC, verify tags applied
- Update rule, sync another order, verify new logic
- Test priority: two rules match, later rule overrides earlier rule

### E2E Tests
- Create complex rule with 4+ conditions
- Test rule against sample order via UI
- Create rule, receive actual order, verify execution
- Edit rule, verify new conditions work

## Rollout Plan
1. **Phase 1** — Schema + engine + API + basic settings UI
2. **Phase 2** — Advanced condition builder UI + test modal
3. **Phase 3** — Order detail card showing matched rules + activity logging
4. **Phase 4** — Rule templates + execution analytics (future)
