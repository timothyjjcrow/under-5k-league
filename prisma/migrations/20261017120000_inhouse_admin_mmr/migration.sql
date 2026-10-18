-- An admin-set inhouse MMR per player. Nullable with no default: unset for
-- everyone, which is what the binary already serving assumes (it never reads
-- or writes the column), so this changes nothing it relies on. No backfill.

BEGIN;

-- AlterTable
ALTER TABLE "User" ADD COLUMN "inhouseMmr" INTEGER;

COMMIT;
