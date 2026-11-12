import "./config/naive-mode";
import app from "./app";

const PORT = Number(process.env.PORT ?? 3000);

app.listen(PORT, () => {
  console.log(`LedgerLab server running on port ${PORT}`);
});