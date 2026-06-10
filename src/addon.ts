import { config } from "../package.json";
import hooks from "./hooks";
import { PDFToMarkdownService } from "./modules/pdfToMd";
import { createZToolkit } from "./utils/ztoolkit";

class Addon {
  public data: {
    alive: boolean;
    config: typeof config;
    // Env type, see build.js
    env: "development" | "production";
    initialized?: boolean;
    ztoolkit: ZToolkit;
    locale?: {
      current: any;
    };
    service: PDFToMarkdownService;
  };
  // Lifecycle hooks
  public hooks: typeof hooks;
  public api: object;

  constructor() {
    this.data = {
      alive: true,
      config,
      env: __env__,
      initialized: false,
      ztoolkit: createZToolkit(),
      service: new PDFToMarkdownService(),
    };
    this.hooks = hooks;
    this.api = {};
  }
}

export default Addon;
