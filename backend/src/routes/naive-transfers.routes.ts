import { Router } from "express";
import {
  createNaiveTransfer,
  type CreateNaiveTransferInput,
} from "../services/naive-transfers.service";

const router = Router();

router.post("/", async (req, res) => {
  try {
    const input: CreateNaiveTransferInput = {
      fromAccountId: req.body.fromAccountId,
      toAccountId: req.body.toAccountId,
      amountPaise: req.body.amountPaise,
    };

    const transfer = await createNaiveTransfer(input);

    return res.status(201).json({
      message: "Naive transfer completed",
      transfer,
    });
  } catch (error) {
    if (error instanceof Error) {
      switch (error.message) {
        case "INVALID_ACCOUNT_ID":
        case "SAME_ACCOUNT_TRANSFER":
        case "INVALID_AMOUNT":
          return res.status(400).json({
            error: error.message,
          });

        case "ACCOUNT_NOT_FOUND":
          return res.status(404).json({
            error: error.message,
          });

        case "ACCOUNT_NOT_ACTIVE":
        case "INSUFFICIENT_FUNDS":
          return res.status(409).json({
            error: error.message,
          });

        case "TRANSFER_COMMIT_OUTCOME_UNKNOWN":
          return res.status(503).json({
            error: "Transfer outcome is unknown. Check the transfer before retrying.",
          });
      }
    }

    console.error("Naive transfer failed:", error);

    return res.status(500).json({
      error: "Internal server error",
    });
  }
});

export default router;