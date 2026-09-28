-- CreateTable
CREATE TABLE "PointsRedemption" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "checkoutToken" TEXT,
    "pointsRequested" INTEGER NOT NULL,
    "pointsRedeemed" INTEGER,
    "amountRedeemed" REAL,
    "billAmount" REAL,
    "amountToPay" REAL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "invoiceNumber" TEXT,
    "approvalCode" TEXT,
    "currentBatchNumber" TEXT,
    "transactionDate" TEXT,
    "giftCardId" TEXT,
    "giftCardLast4" TEXT,
    "lastPingAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reverseAttempts" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "PointsRedemption_status_lastPingAt_idx" ON "PointsRedemption"("status", "lastPingAt");

-- CreateIndex
CREATE INDEX "PointsRedemption_customerId_status_idx" ON "PointsRedemption"("customerId", "status");
