-- AlterTable
ALTER TABLE "complaints" ADD COLUMN     "is_restricted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reporter_email_enc" TEXT,
ADD COLUMN     "reporter_name_enc" TEXT,
ADD COLUMN     "reporter_phone_enc" TEXT;

