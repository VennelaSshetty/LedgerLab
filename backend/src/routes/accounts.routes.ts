import { Router } from "express";
import {
  createAccount,
  getAccountBalance,
  getAccountTransfers,
} from "../services/accounts.service";

const router = Router();

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.post("/", async (req, res) => {
  const { userId } = req.body ?? {};

  if (typeof userId !== "string" || !UUID_REGEX.test(userId)) {
    return res.status(400).json({
      error: "A valid userId is required",
    });
  }

  try {
    const account = await createAccount(userId);

    return res.status(201).json({
      message: "Account created successfully",
      account,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "USER_NOT_FOUND") {
      return res.status(404).json({
        error: "User not found",
      });
    }

    console.error("Account creation failed:", error);

    return res.status(500).json({
      error: "Failed to create account",
    });
  }
});

router.get("/:id/balance", async (req, res) => {
  const { id } = req.params;

  if (!UUID_REGEX.test(id)) {
    return res.status(400).json({
      error: "Invalid account ID",
    });
  }

  try {
    const account = await getAccountBalance(id);

    if (!account) {
      return res.status(404).json({
        error: "Account not found",
      });
    }

    return res.status(200).json({
      account,
    });
  } catch (error) {
    console.error("Balance retrieval failed:", error);

    return res.status(500).json({
      error: "Failed to retrieve account balance",
    });
  }
});

router.get("/:id/transfers", async (req, res) => {
  const { id } = req.params;

  if (!UUID_REGEX.test(id)) {
    return res.status(400).json({
      error: "Invalid account ID",
    });
  }

  try {
    const transfers = await getAccountTransfers(id);

    if (transfers === null) {
  return res.status(404).json({
    error: "Account not found",
  });
}

    return res.status(200).json({
      accountId: id,
      count: transfers.length,
      transfers,
    });
  } catch (error) {
    console.error("Transfer history retrieval failed:", error);

    return res.status(500).json({
      error: "Failed to retrieve transfer history",
    });
  }
});

export default router;