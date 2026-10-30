// SPDX-License-Identifier: MIT

import chalk from "chalk";
import { clearCredentials, getCredentials } from "../lib/config.js";

export function logout(): void {
  if (!getCredentials()) {
    console.log("Not logged in.");
    return;
  }
  clearCredentials();
  console.log(chalk.green("Logged out."));
}
