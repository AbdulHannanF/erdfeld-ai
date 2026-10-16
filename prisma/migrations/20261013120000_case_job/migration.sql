-- AlterTable
ALTER TABLE "Case" ADD COLUMN     "jobId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Case_jobId_key" ON "Case"("jobId");
