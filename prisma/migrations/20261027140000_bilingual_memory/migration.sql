-- AlterTable
ALTER TABLE "KnowledgeBase" ADD COLUMN "memoryJson" TEXT;
ALTER TABLE "KnowledgeBase" ADD COLUMN "memoryUpdatedAt" DATETIME;

-- AlterTable
ALTER TABLE "OnboardingQuestion" ADD COLUMN "promptFa" TEXT NOT NULL DEFAULT '';
