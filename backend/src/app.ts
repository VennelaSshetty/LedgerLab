import express from "express";
import accountsRouter from "./routes/accounts.routes";
import transfersRouter from "./routes/transfers.routes";
import naiveTransfersRouter from "./routes/naive-transfers.routes";
import { isNaiveModeEnabled } from "./config/naive-mode";

const app = express();

app.use(express.json());

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: "LedgerLab",
  });
});

app.use("/api/accounts", accountsRouter);
app.use("/api/transfers", transfersRouter);

if (isNaiveModeEnabled) {
  app.use("/api/naive-transfers", naiveTransfersRouter);
}

export default app;