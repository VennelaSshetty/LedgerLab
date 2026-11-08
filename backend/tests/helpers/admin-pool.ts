import dotenv from "dotenv";
import { Pool } from "pg";

dotenv.config({ path: "../infra/.env" });

export const adminPool = new Pool({
  host: "127.0.0.1",
  port: Number(process.env.POSTGRES_PORT ?? 5433),
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
});