-- CreateTable
CREATE TABLE "Case" (
    "id" TEXT NOT NULL,
    "ownerToken" TEXT,
    "claimType" TEXT NOT NULL,
    "recipe" TEXT NOT NULL,
    "geometry" JSONB NOT NULL,
    "params" JSONB NOT NULL,
    "verdict" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "decision" JSONB NOT NULL,
    "runId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Case_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Case_ownerToken_idx" ON "Case"("ownerToken");

-- CreateIndex
CREATE INDEX "Case_runId_idx" ON "Case"("runId");
