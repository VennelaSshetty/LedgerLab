import dotenv from "dotenv";
import { Pool } from "pg";

dotenv.config({ path: "../infra/.env" });

export const verifierPool = new Pool({
  host: "127.0.0.1",
  port: Number(process.env.POSTGRES_PORT ?? 5433),
  database: process.env.POSTGRES_DB,
  user: process.env.VERIFIER_DB_USER,
  password: process.env.VERIFIER_DB_PASSWORD,
  allowExitOnIdle: true,
});