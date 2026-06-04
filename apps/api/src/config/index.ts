import path from "node:path";

export const config = {
  port: parseInt(process.env.PORT ?? "3001", 10),
  dataDir: process.env.DATA_DIR ?? path.resolve("../../../data"),
};
