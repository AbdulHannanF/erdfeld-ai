-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerToken" TEXT,
    "aoi" JSONB,
    "mapStyle" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShareLink" (
    "token" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "viewCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ShareLink_pkey" PRIMARY KEY ("token")
);

-- CreateTable
CREATE TABLE "Layer" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "layerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "tileUrl" TEXT,
    "geojson" JSONB,
    "imageBase64" TEXT,
    "color" TEXT,
    "intensityProperty" TEXT,
    "render" TEXT,
    "heightProperty" TEXT,
    "bounds" JSONB,
    "palette" JSONB,
    "provenance" JSONB,
    "confidence" TEXT,
    "resultId" TEXT,
    "tool" TEXT,
    "summaryData" JSONB,
    "aoiKey" TEXT,
    "opacity" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Layer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "resultId" TEXT,
    "summaryData" JSONB,
    "toolResults" JSONB,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Result" (
    "resultId" TEXT NOT NULL,
    "inputsHash" TEXT NOT NULL,
    "cacheKey" TEXT,
    "opName" TEXT NOT NULL,
    "opVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "Result_pkey" PRIMARY KEY ("resultId")
);

-- CreateTable
CREATE TABLE "PlanRun" (
    "id" TEXT NOT NULL,
    "ownerToken" TEXT,
    "query" TEXT,
    "aoi" JSONB NOT NULL,
    "focus" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanNode" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "idx" INTEGER NOT NULL,
    "op" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "args" JSONB NOT NULL,
    "dependsOn" JSONB NOT NULL,
    "inputsHash" TEXT,
    "resultId" TEXT,
    "status" TEXT NOT NULL,
    "cached" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "ms" INTEGER NOT NULL,

    CONSTRAINT "PlanNode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Project_ownerToken_idx" ON "Project"("ownerToken");

-- CreateIndex
CREATE INDEX "ShareLink_projectId_idx" ON "ShareLink"("projectId");

-- CreateIndex
CREATE INDEX "Layer_projectId_idx" ON "Layer"("projectId");

-- CreateIndex
CREATE INDEX "Message_projectId_idx" ON "Message"("projectId");

-- CreateIndex
CREATE INDEX "Result_cacheKey_idx" ON "Result"("cacheKey");

-- CreateIndex
CREATE INDEX "Result_inputsHash_idx" ON "Result"("inputsHash");

-- CreateIndex
CREATE INDEX "PlanRun_ownerToken_idx" ON "PlanRun"("ownerToken");

-- CreateIndex
CREATE INDEX "PlanNode_resultId_idx" ON "PlanNode"("resultId");

-- CreateIndex
CREATE UNIQUE INDEX "PlanNode_runId_idx_key" ON "PlanNode"("runId", "idx");

-- AddForeignKey
ALTER TABLE "ShareLink" ADD CONSTRAINT "ShareLink_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Layer" ADD CONSTRAINT "Layer_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanNode" ADD CONSTRAINT "PlanNode_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PlanRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
