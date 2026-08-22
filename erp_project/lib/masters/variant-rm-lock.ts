/**
 * Variant-family RM ownership — "RM belongs to the family, PM belongs to the SKU."
 *
 * A variant family is the set of SKUs sharing one `master_skus.brand` +
 * `base_sku_sno` (see skus.selectVariantFamilyBySkuId). Physically they are the
 * same formulation in different pack sizes, so RM is identical across the family
 * and only PM differs. This module answers the one question both the Recipe
 * wizard and the create-full route need: **may this SKU's recipe change RM, and
 * if not, whose RM does it inherit?**
 *
 * Pure on purpose — no DB, no imports. The caller does the query; this decides.
 * The route MUST re-run it server-side: the wizard greying out the RM grid is
 * never the guard (see app/api/v1/masters/recipe-master/route.ts).
 */

export type FamilyMember = {
  id: number
  sku_code: string
  /** master_skus.is_base_sku — mysql2 hands TINYINT(1) back as 0/1. */
  is_base_sku: number | boolean
  /** The member's currently-active master_recipe.id, or null if it has none. */
  active_recipe_id: number | null
  bom_code: string | null
  /** That active recipe's rm_version — the family's RM lineage position. */
  rm_version?: number | null
  /** master_recipe.created_at of that active recipe — breaks owner ties. */
  recipe_created_at?: Date | string | null
}

export type RmLock =
  | {
      locked: false
      /** Why RM is editable — drives nothing but the wizard's copy and tests. */
      why: "no_family" | "is_base" | "no_sibling_recipe"
    }
  | {
      locked: true
      /** The SKU whose recipe owns this family's RM. */
      ownerSkuCode: string
      ownerRecipeId: number
      ownerBomCode: string | null
      /**
       * Whether a base SKU is actually marked for this family. False means the
       * owner was inferred (rule 4's fallback), so the UI must say "designate a
       * base SKU" rather than "edit the base SKU" — there is no base to edit.
       */
      baseDesignated: boolean
    }

const isBase = (m: FamilyMember) => m.is_base_sku === 1 || m.is_base_sku === true

/**
 * Highest RM version first, newest recipe as the tie-break — the order that
 * decides which member's recipe currently defines the family's RM.
 *
 * RM version leads, not recency: every member of a family in step carries the
 * SAME rm_version, so recency alone would pick an arbitrary one of them, and a
 * member left behind on an older formulation must never be read as the head.
 */
function rmLineageFirst(a: FamilyMember, b: FamilyMember) {
  const av = Number(a.rm_version ?? 0)
  const bv = Number(b.rm_version ?? 0)
  if (bv !== av) return bv - av
  const at = a.recipe_created_at ? new Date(a.recipe_created_at).getTime() : 0
  const bt = b.recipe_created_at ? new Date(b.recipe_created_at).getTime() : 0
  if (bt !== at) return bt - at
  // No usable timestamps (or a dead heat) — fall back to the higher id, which
  // for an AUTO_INCREMENT recipe is the later one. Deterministic either way;
  // an arbitrary owner here would make the lock flap between requests.
  return b.id - a.id
}

/**
 * The family member whose active recipe currently defines the family's RM, or
 * null when nobody in the family has one yet.
 *
 * The single definition of "the family's current RM", used both to seed/validate
 * a locked variant's RM and to number it — so the lock and the version can never
 * disagree about which recipe they mean.
 */
export function rmLineageHead(family: FamilyMember[]): FamilyMember | null {
  const withRecipe = family.filter((m) => m.active_recipe_id != null)
  if (withRecipe.length === 0) return null
  return [...withRecipe].sort(rmLineageFirst)[0]
}

export function resolveRmLock(skuId: number, family: FamilyMember[]): RmLock {
  // Not in a family at all (base_sku_sno IS NULL selects zero rows), or the
  // only member of one. Nothing to share RM with.
  if (family.length <= 1) return { locked: false, why: "no_family" }

  const self = family.find((m) => m.id === skuId)
  // The marked base may change RM — that is the ONLY way to change it. Checked
  // before the sibling-recipe test below, so a base whose siblings already have
  // recipes stays editable.
  if (self && isBase(self)) return { locked: false, why: "is_base" }

  const withRecipe = family.filter((m) => m.active_recipe_id != null)
  // Nobody in the family has a recipe yet, so there is no RM to inherit. The
  // first member to get one effectively seeds the family's RM.
  if (withRecipe.length === 0) return { locked: false, why: "no_sibling_recipe" }

  // Locked. Prefer the marked base's recipe as the RM source; fall back to the
  // RM lineage head so inheritance works TODAY, before anyone has designated a
  // base (no family has one — the column ships at 0).
  const markedBase = family.find(isBase)
  const owner =
    (markedBase && withRecipe.find((m) => m.id === markedBase.id)) ??
    rmLineageHead(family)!

  return {
    locked: true,
    ownerSkuCode: owner.sku_code,
    ownerRecipeId: owner.active_recipe_id!,
    ownerBomCode: owner.bom_code,
    baseDesignated: markedBase != null,
  }
}

/**
 * The siblings a base-SKU RM change must fan out to: every OTHER family member
 * that already has an active recipe. Members with no recipe are skipped — there
 * is no version to bump, and they inherit the new RM (pre-seeded and locked)
 * whenever their first recipe is created.
 */
export function rmPropagationTargets(skuId: number, family: FamilyMember[]): FamilyMember[] {
  return family.filter((m) => m.id !== skuId && m.active_recipe_id != null)
}

/**
 * THE INVARIANT: every active recipe in a variant family carries the SAME
 * `rm_version`. Variants of one product are one formulation in different pack
 * sizes, so two of them claiming different RM revisions means at least one is
 * being manufactured or costed against a formulation nobody approved for it.
 *
 * Returns the members that disagree with the lineage head — empty when the
 * family is in step (including a family with 0 or 1 active recipes, which cannot
 * disagree with itself). Members with no active recipe are not drift: they have
 * nothing to be out of step WITH, and inherit the RM when they get a recipe.
 *
 * A pure predicate rather than a DB constraint because the invariant spans rows
 * (every active recipe of every SKU sharing a grouping key) — no column-level
 * constraint can express it. Every write path that can activate a recipe has to
 * call it: create-full's lock, bomBulkHandler's per-group check,
 * propagateRmToVariants' atomicity, and update-status. Miss one and the
 * invariant is merely a convention.
 */
export function rmDrift(family: FamilyMember[]): {
  headVersion: number | null
  outliers: FamilyMember[]
} {
  const head = rmLineageHead(family)
  if (!head) return { headVersion: null, outliers: [] }

  const headVersion = Number(head.rm_version ?? 0)
  return {
    headVersion,
    outliers: family.filter(
      (m) => m.active_recipe_id != null && Number(m.rm_version ?? 0) !== headVersion
    ),
  }
}

/** Human-readable "who disagrees", for an error message or a warning banner. */
export function describeRmDrift(family: FamilyMember[]): string | null {
  const { headVersion, outliers } = rmDrift(family)
  if (outliers.length === 0) return null
  const who = outliers
    .map((m) => `${m.sku_code} (RM${Number(m.rm_version ?? 0)})`)
    .join(", ")
  return `this variant family is split across RM versions — the family is on RM${headVersion}, but ${who}`
}
