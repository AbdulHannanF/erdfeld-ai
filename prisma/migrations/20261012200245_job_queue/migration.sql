-- CreateTable
CREATE TABLE "JobBatch" (
    "id" TEXT NOT NULL,
    "ownerToken" TEXT,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "idx" INTEGER NOT NULL,
    "op" TEXT NOT NULL,
    "args" JSONB NOT NULL,
    "aoi" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),
    "workerId" TEXT,
    "resultId" TEXT,
    "resultStatus" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobEvent" (
    "id" SERIAL NOT NULL,
    "batchId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JobBatch_ownerToken_idx" ON "JobBatch"("ownerToken");

-- CreateIndex
CREATE INDEX "Job_status_runAt_idx" ON "Job"("status", "runAt");

-- CreateIndex
CREATE INDEX "Job_resultId_idx" ON "Job"("resultId");

-- CreateIndex
CREATE UNIQUE INDEX "Job_batchId_idx_key" ON "Job"("batchId", "idx");

-- CreateIndex
CREATE INDEX "JobEvent_batchId_id_idx" ON "JobEvent"("batchId", "id");

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "JobBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobEvent" ADD CONSTRAINT "JobEvent_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "JobBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
