import { cpSync } from "node:fs";
cpSync("src/ui/index.html", "dist/ui/index.html");
cpSync("src/ui/style.css", "dist/ui/style.css");
