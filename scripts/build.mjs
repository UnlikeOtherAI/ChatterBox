import { cpSync } from "node:fs";
cpSync("src/ui/index.html", "dist/ui/index.html");
cpSync("src/ui/style.css", "dist/ui/style.css");
cpSync("assets/icon.png", "dist/desktop/icon.png");
cpSync("assets/icon.png", "dist/ui/icon.png");
