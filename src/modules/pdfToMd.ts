/* eslint-disable @typescript-eslint/ban-ts-comment, no-empty */
// @ts-nocheck
import { config } from "../../package.json";
import { getPref, setPref } from "../utils/prefs";
import { renderMarkdownToHTML, renderMarkdownZipToHTML } from "./renderHtml";

export type OutputFormat = "markdown" | "html";

type ZoteroWindow = _ZoteroTypes.MainWindow & {
  ZoteroPane: _ZoteroTypes.ZoteroPane;
  fetch: typeof fetch;
  AbortController?: typeof AbortController;
  Blob: typeof Blob;
  File?: typeof File;
  setTimeout: Window["setTimeout"];
  clearTimeout: Window["clearTimeout"];
};

type ConvertOptions = {
  interactive: boolean;
  outputFormat: OutputFormat;
};

type Candidate = {
  att: Zotero.Item;
  parent: Zotero.Item | null;
  sourceItem: Zotero.Item;
};

export type ConversionJob = {
  att: Zotero.Item;
  parent: Zotero.Item | null;
  path: string;
  pdfName: string;
  outputName: string;
  outputFormat: OutputFormat;
  contentType: "text/markdown" | "text/html";
  dataId: string;
  finished: boolean;
  saved: boolean;
  errMsg: string;
};

type StatusBox = {
  win: ZoteroWindow;
  el: HTMLElement;
  head: HTMLElement;
  list: HTMLElement;
  note: HTMLElement;
  rows: Map<string, HTMLElement>;
  timer: number | null;
};

const HTML_NS = "http://www.w3.org/1999/xhtml";
const API_BASE = "https://mineru.net/api/v4";
const AGENT_BASE = "https://mineru.net/api/v1/agent";
const BATCH_LIMIT = 50;
const POLL_INTERVAL = 5000;
const POLL_TIMEOUT = 45 * 60 * 1000;
const LIGHT_POLL_INTERVAL = 4000;
const LIGHT_POLL_TIMEOUT = 15 * 60 * 1000;
const LOCAL_API_TIMEOUT = 600000;
const LOCAL_ROUTER_TIMEOUT = 900000;
const LOCAL_ROUTER_POLL = 5000;
const ATTACHMENT_TAG = "#PDF2MD";
const PARENT_TAG = "#PDF2MD-Converted";

export class PDFToMarkdownService {
  private busy = false;
  private chain = Promise.resolve();
  private notifierID: string | null = null;
  private autoQueue = new Set<number>();
  private autoScheduled = false;
  private status: StatusBox | null = null;

  init(): void {
    this.notifierID = Zotero.Notifier.registerObserver(
      {
        notify: (event: string, type: string, ids: Array<number | string>) => {
          this.onNotify(event, type, ids).catch((e) =>
            this.log(`Notifier error: ${this.errorMessage(e)}`),
          );
        },
      },
      ["item"],
      config.addonRef,
    );
  }

  shutdown(): void {
    if (this.notifierID) {
      Zotero.Notifier.unregisterObserver(this.notifierID);
      this.notifierID = null;
    }
    this.removeFromAllWindows();
  }

  registerPrefs(): void {
    Zotero.PreferencePanes.register({
      pluginID: config.addonID,
      src: rootURI + "content/preferences.xhtml",
      label: "PDF to Markdown",
      image: `chrome://${config.addonRef}/content/icons/favicon.png`,
    });
  }

  addToAllWindows(): void {
    for (const win of Zotero.getMainWindows()) {
      this.addToWindow(win as ZoteroWindow);
    }
  }

  addToWindow(win: ZoteroWindow): void {
    const doc = win.document;
    const itemmenu = doc.getElementById("zotero-itemmenu");
    if (!itemmenu || doc.getElementById(`${config.addonRef}-menu`)) return;

    const parent = doc.createXULElement("menu");
    parent.id = `${config.addonRef}-menu`;
    parent.setAttribute("label", "PDF to Markdown");

    const popup = doc.createXULElement("menupopup");
    parent.appendChild(popup);
    itemmenu.appendChild(parent);

    const updateVisibility = () => {
      const items = this.getSelectedItems(win);
      parent.hidden = !this.hasProcessableSelection(items);
    };
    itemmenu.addEventListener("popupshowing", updateVisibility);

    const add = (id: string, label: string, fn: () => Promise<void>) => {
      const mi = doc.createXULElement("menuitem");
      mi.id = `${config.addonRef}-${id}`;
      mi.setAttribute("label", label);
      mi.addEventListener("command", () => {
        fn().catch((e) => {
          this.log(`Error: ${this.errorMessage(e)}\n${e?.stack || ""}`);
          win.alert(`PDF2MD: ${this.errorMessage(e)}`);
        });
      });
      popup.appendChild(mi);
    };

    popup.addEventListener("popupshowing", updateVisibility);

    add("convert-md", "转换为 Markdown (MinerU)", () =>
      this.convertSelectedItems(win, "markdown"),
    );
    add("convert-html", "转换为 HTML (MinerU)", () =>
      this.convertSelectedItems(win, "html"),
    );
    add("export", "导出附件", () => this.exportSelected(win, false));
    add("export-to", "导出附件到…", () => this.exportSelected(win, true));
  }

  removeFromAllWindows(): void {
    for (const win of Zotero.getMainWindows()) {
      this.removeFromWindow(win as ZoteroWindow);
    }
  }

  removeFromWindow(win: ZoteroWindow): void {
    win.document.getElementById(`${config.addonRef}-menu`)?.remove();
    win.document.getElementById(`${config.addonRef}-status`)?.remove();
    for (const toast of win.document.querySelectorAll(
      `.${config.addonRef}-toast`,
    )) {
      toast.remove();
    }
    if (this.status?.win === win) this.status = null;
  }

  onPrefsLoad(win: Window): void {
    this.bindFolderPicker(win);
    this.bindLocalApiTest(win);
  }

  async convertSelectedItems(
    win: ZoteroWindow,
    outputFormat: OutputFormat,
  ): Promise<void> {
    const items = this.getSelectedItems(win);
    if (!items.length) {
      win.alert("未选择条目。");
      return;
    }
    this.enqueueConvert(items, win, { interactive: true, outputFormat });
  }

  enqueueConvert(
    items: Zotero.Item[],
    win: ZoteroWindow | null,
    opts: ConvertOptions,
  ): Promise<void> {
    if (this.busy) this.toast(["PDF2MD: 已加入队列"], 2000);
    this.chain = this.chain
      .then(() => this.runConversion(items, win, opts))
      .catch((e) => this.log(`Run error: ${this.errorMessage(e)}`));
    return this.chain;
  }

  private async onNotify(
    event: string,
    type: string,
    ids: Array<number | string>,
  ): Promise<void> {
    if (event !== "add" || type !== "item" || !getPref("autoConvert")) return;
    for (const id of ids) {
      const item = Zotero.Items.get(Number(id));
      if (this.isPDFAttachment(item)) this.autoQueue.add(item.id);
    }
    if (!this.autoQueue.size || this.autoScheduled) return;
    this.autoScheduled = true;
    await Zotero.Promise.delay(15000);
    this.autoScheduled = false;
    if (!addon.data.alive) return;

    const items = Zotero.Items.get([...this.autoQueue]).filter(
      Boolean,
    ) as Zotero.Item[];
    this.autoQueue.clear();
    for (const item of items) {
      let waited = 0;
      while (!(await item.getFilePathAsync()) && waited < 60000) {
        await Zotero.Promise.delay(5000);
        waited += 5000;
      }
    }
    if (items.length) {
      this.enqueueConvert(items, Zotero.getMainWindow() as ZoteroWindow, {
        interactive: false,
        outputFormat: "markdown",
      });
    }
  }

  private async runConversion(
    items: Zotero.Item[],
    win: ZoteroWindow | null,
    { interactive, outputFormat }: ConvertOptions,
  ): Promise<void> {
    if (!addon.data.alive) return;

    const useLocal = !!getPref("useLocalApi");
    let token = "";
    let light = false;
    if (!useLocal) {
      token = String(getPref("apiToken") || "").trim();
      token = token.replace(/^Bearer\s+/i, "");
      light = !token;
    }

    const { jobs, skipped } = await this.collectJobs(items, outputFormat);
    if (skipped.length) this.log(`Skipped:\n  ${skipped.join("\n  ")}`);
    if (!jobs.length) {
      if (interactive)
        this.toast(["PDF2MD: 没有可转换的 PDF", "详情见调试日志"]);
      return;
    }

    this.busy = true;
    try {
      this.statusShow(`PDF2MD ${outputFormat.toUpperCase()} 0/${jobs.length}`);
      for (const job of jobs) {
        this.statusLine(job.dataId, `• ${this.short(job.pdfName)}`);
      }

      const notes: string[] = [];
      if (useLocal)
        notes.push(`本地 API: ${String(getPref("localApiUrl") || "")}`);
      else if (light) notes.push("轻量接口,未填写 Token (≤20 页)");
      if (skipped.length) notes.push(`已跳过 ${skipped.length} 个`);
      if (notes.length) this.statusNote(notes.join(" · "));

      let done = 0;
      const onFinish = () => {
        done++;
        this.statusHeadline(
          `PDF2MD ${outputFormat.toUpperCase()} ${done}/${jobs.length}`,
        );
      };

      if (useLocal) {
        const apiType = String(getPref("localApiType") || "api");
        if (apiType === "router") {
          const concurrency = this.getIntPref(
            "localRouterConcurrency",
            2,
            1,
            8,
          );
          await this.processLocalJobsConcurrent(jobs, concurrency, onFinish);
        } else {
          for (const job of jobs) {
            await this.processLocalJob(job);
            onFinish();
          }
        }
      } else if (light) {
        for (const job of jobs) {
          await this.processLight(job);
          onFinish();
        }
      } else {
        for (let i = 0; i < jobs.length; i += BATCH_LIMIT) {
          await this.processBatch(
            jobs.slice(i, i + BATCH_LIMIT),
            token,
            onFinish,
          );
        }
      }

      const ok = jobs.filter((j) => j.saved).length;
      const failed = jobs.length - ok;
      this.statusHeadline(
        `PDF2MD: 完成 ${ok} 个${failed ? `, 失败 ${failed} 个` : ""}`,
      );
    } catch (e) {
      this.log(`Conversion error: ${this.errorMessage(e)}\n${e?.stack || ""}`);
      this.statusHeadline("PDF2MD 出错");
      this.statusNote(this.short(this.errorMessage(e), 60));
      if (interactive && win) win.alert(`PDF2MD: ${this.errorMessage(e)}`);
    } finally {
      this.busy = false;
      this.statusClose(8000);
    }
  }

  private async collectJobs(
    items: Zotero.Item[],
    outputFormat: OutputFormat,
  ): Promise<{ jobs: ConversionJob[]; skipped: string[] }> {
    const candidates: Candidate[] = [];
    const seen = new Set<number>();
    const skipped: string[] = [];

    for (const item of items) {
      try {
        if (item.isAttachment()) {
          if (this.isPDFAttachment(item)) {
            if (!seen.has(item.id)) {
              seen.add(item.id);
              candidates.push({
                att: item,
                parent: item.parentItem || null,
                sourceItem: item,
              });
            }
          } else {
            skipped.push(`${this.label(item)}: 不是 PDF 附件`);
          }
        } else if (item.isRegularItem()) {
          let found = 0;
          for (const id of item.getAttachments()) {
            const att = Zotero.Items.get(id);
            if (!this.isPDFAttachment(att)) continue;
            found++;
            if (!seen.has(att.id)) {
              seen.add(att.id);
              candidates.push({ att, parent: item, sourceItem: item });
            }
          }
          if (!found) skipped.push(`${this.label(item)}: 没有 PDF 附件`);
        } else {
          skipped.push(`${this.label(item)}: 不可转换`);
        }
      } catch (e) {
        skipped.push(`${this.label(item)}: ${this.errorMessage(e)}`);
      }
    }

    const jobs: ConversionJob[] = [];
    for (const { att, parent, sourceItem } of candidates) {
      try {
        const path = await att.getFilePathAsync();
        if (!path) {
          skipped.push(`${this.label(sourceItem)}: PDF 不在本地磁盘`);
          continue;
        }
        const pdfName = PathUtils.filename(path);
        const siblingPDFCount = parent
          ? this.countParentPDFAttachments(parent)
          : 1;
        const outputName = this.outputName(
          parent,
          pdfName,
          siblingPDFCount > 1,
          outputFormat,
        );
        if (parent && this.hasOutputAttachment(parent, outputName)) {
          skipped.push(`${this.label(sourceItem)}: 已存在 ${outputName}`);
          continue;
        }
        jobs.push({
          att,
          parent,
          path,
          pdfName,
          outputName,
          outputFormat,
          contentType: outputFormat === "html" ? "text/html" : "text/markdown",
          dataId: `L${att.libraryID}-${att.key}`,
          finished: false,
          saved: false,
          errMsg: "",
        });
      } catch (e) {
        skipped.push(`${this.label(sourceItem)}: ${this.errorMessage(e)}`);
      }
    }
    return { jobs, skipped };
  }

  private async processBatch(
    jobs: ConversionJob[],
    token: string,
    onFinish: () => void,
  ): Promise<void> {
    const body = {
      files: jobs.map((j) => ({
        name: `${j.dataId}.pdf`,
        data_id: j.dataId,
        is_ocr: !!getPref("isOcr"),
      })),
      model_version: String(getPref("modelVersion") || "vlm"),
      language: String(getPref("language") || "ch").trim() || "ch",
      enable_formula: !!getPref("enableFormula"),
      enable_table: !!getPref("enableTable"),
      layout_model: "doclayout_yolo",
    };
    const data = await this.api(
      "POST",
      `${API_BASE}/file-urls/batch`,
      body,
      token,
    );
    const batchId = data.batch_id;
    const urls = data.file_urls || [];
    if (urls.length !== jobs.length) {
      throw new Error(
        `got ${urls.length} upload URLs for ${jobs.length} files`,
      );
    }

    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      this.setLine(job, "上传中");
      const bytes = await IOUtils.read(job.path);
      const resp = await this.fetch(urls[i], { method: "PUT", body: bytes });
      if (!resp.ok) throw new Error(`upload failed (HTTP ${resp.status})`);
      this.setLine(job, "排队中");
    }

    const byDataId = new Map(jobs.map((j) => [j.dataId, j]));
    const start = Date.now();
    while (addon.data.alive) {
      if (Date.now() - start > POLL_TIMEOUT) {
        throw new Error(`timed out (batch ${batchId})`);
      }
      await Zotero.Promise.delay(POLL_INTERVAL);
      let result: any;
      try {
        result = await this.api(
          "GET",
          `${API_BASE}/extract-results/batch/${batchId}`,
          null,
          token,
        );
      } catch (e) {
        this.log(`Poll error (retrying): ${this.errorMessage(e)}`);
        continue;
      }
      for (const r of result.extract_result || []) {
        const job = byDataId.get(r.data_id);
        if (!job || job.finished) continue;
        if (r.state === "failed") {
          job.finished = true;
          job.errMsg = r.err_msg || "解析失败";
          this.setLine(job, this.short(job.errMsg, 40), "error");
          onFinish();
        } else if (r.state === "done") {
          job.finished = true;
          this.setLine(job, "保存中");
          try {
            await this.saveZipResult(job, r.full_zip_url);
            job.saved = true;
            this.setLine(job, "完成", "done");
          } catch (e) {
            job.errMsg = this.errorMessage(e);
            this.setLine(job, this.short(job.errMsg, 40), "error");
          }
          onFinish();
        } else {
          this.setLine(job, this.stateText(r));
        }
      }
      if (!jobs.some((j) => !j.finished)) break;
    }
  }

  private async processLight(job: ConversionJob): Promise<void> {
    try {
      this.setLine(job, "提交中");
      const bytes = await IOUtils.read(job.path);
      const win = this.mainWindow();
      const formData = new win.FormData();
      const blob = new win.Blob([bytes], { type: "application/pdf" });
      if (win.File) {
        formData.append(
          "file",
          new win.File([blob], job.pdfName, { type: "application/pdf" }),
        );
      } else {
        formData.append("file", blob, job.pdfName);
      }
      formData.append("parse_method", getPref("isOcr") ? "ocr" : "auto");
      formData.append("enable_formula", String(!!getPref("enableFormula")));
      formData.append("enable_table", String(!!getPref("enableTable")));
      formData.append("language", String(getPref("language") || "ch"));

      const submit = await this.fetch(`${AGENT_BASE}/file_parse`, {
        method: "POST",
        body: formData,
      });
      if (!submit.ok) throw new Error(`light API HTTP ${submit.status}`);
      const data = await submit.json();
      const batchId = data?.data?.batch_id || data?.batch_id;
      if (!batchId) throw new Error("light API returned no batch_id");

      const start = Date.now();
      while (addon.data.alive) {
        if (Date.now() - start > LIGHT_POLL_TIMEOUT) {
          throw new Error("light API timed out");
        }
        await Zotero.Promise.delay(LIGHT_POLL_INTERVAL);
        const resp = await this.fetch(
          `${AGENT_BASE}/extract-results/${batchId}`,
        );
        if (!resp.ok) continue;
        const json = await resp.json();
        const r = json?.data || json;
        if (r.state === "failed") throw new Error(r.err_msg || "解析失败");
        if (r.state === "done") {
          this.setLine(job, "保存中");
          await this.saveLightResult(job, r.markdown_url);
          job.saved = true;
          this.setLine(job, "完成", "done");
          break;
        }
        this.setLine(job, this.stateText(r));
      }
    } catch (e) {
      job.errMsg = this.errorMessage(e);
      this.setLine(job, this.short(job.errMsg, 40), "error");
    } finally {
      job.finished = true;
    }
  }

  private async processLocalJob(job: ConversionJob): Promise<void> {
    if (String(getPref("localApiType") || "api") === "router") {
      await this.processLocalRouter(job);
    } else {
      await this.processLocalApi(job);
    }
  }

  private async processLocalJobsConcurrent(
    jobs: ConversionJob[],
    limit: number,
    onFinish: () => void,
  ): Promise<void> {
    let next = 0;
    const workerCount = Math.min(Math.max(1, limit || 1), jobs.length);
    const worker = async () => {
      while (addon.data.alive) {
        const job = jobs[next++];
        if (!job) return;
        await this.processLocalRouter(job);
        onFinish();
      }
    };
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  }

  private async processLocalApi(job: ConversionJob): Promise<void> {
    try {
      this.setLine(job, "上传中");
      const apiUrl = this.localApiUrl();
      const bytes = await IOUtils.read(job.path);
      const formData = this.localFormData(bytes, job.pdfName);
      formData.append("backend", "pipeline");
      formData.append("lang_list", String(getPref("language") || "ch"));
      formData.append("parse_method", getPref("isOcr") ? "ocr" : "auto");
      formData.append("formula_enable", String(!!getPref("enableFormula")));
      formData.append("table_enable", String(!!getPref("enableTable")));
      formData.append("image_analysis", "true");
      formData.append("return_md", "true");
      formData.append("return_middle_json", "true");
      formData.append("return_model_output", "false");
      formData.append("return_content_list", "true");
      formData.append("return_images", "true");
      formData.append("response_format_zip", "true");

      const resp = await this.fetchWithTimeout(
        `${apiUrl}/file_parse`,
        { method: "POST", body: formData },
        LOCAL_API_TIMEOUT,
      );
      if (!resp.ok) throw new Error(`local API HTTP ${resp.status}`);
      if (this.responseLooksLikeJSON(resp)) {
        throw new Error("local API returned JSON, expected ZIP");
      }
      await this.saveLocalZipResult(job, resp);
      job.saved = true;
      this.setLine(job, "完成", "done");
    } catch (e) {
      job.errMsg = this.errorMessage(e);
      this.setLine(job, this.short(job.errMsg, 40), "error");
    } finally {
      job.finished = true;
    }
  }

  private async processLocalRouter(job: ConversionJob): Promise<void> {
    try {
      this.setLine(job, "上传中");
      const apiUrl = this.localApiUrl();
      const bytes = await IOUtils.read(job.path);
      const formData = this.localFormData(bytes, job.pdfName);
      formData.append("backend", "hybrid-auto-engine");
      formData.append("lang_list", String(getPref("language") || "ch"));
      formData.append("parse_method", getPref("isOcr") ? "ocr" : "auto");
      formData.append("formula_enable", String(!!getPref("enableFormula")));
      formData.append("table_enable", String(!!getPref("enableTable")));
      formData.append("image_analysis", "true");
      formData.append("return_md", "true");
      formData.append("return_middle_json", "true");
      formData.append("return_content_list", "true");
      formData.append("return_images", "true");
      formData.append("response_format_zip", "true");

      const submitResp = await this.fetchWithTimeout(
        `${apiUrl}/tasks`,
        { method: "POST", body: formData },
        60000,
      );
      if (!submitResp.ok)
        throw new Error(`router submit HTTP ${submitResp.status}`);
      const taskJson = await submitResp.json();
      const taskId = taskJson.task_id;
      if (!taskId) throw new Error("router returned no task_id");
      this.setLine(job, "排队中");

      const start = Date.now();
      while (addon.data.alive) {
        if (Date.now() - start > LOCAL_ROUTER_TIMEOUT) {
          throw new Error("router timed out");
        }
        await Zotero.Promise.delay(LOCAL_ROUTER_POLL);
        const pollResp = await this.fetch(`${apiUrl}/tasks/${taskId}`);
        if (!pollResp.ok) continue;
        const pollJson = await pollResp.json();
        const status = String(pollJson.status || "").toLowerCase();
        if (status === "completed") break;
        if (status === "failed" || status === "error") {
          throw new Error(`router task ${status}`);
        }
        this.setLine(job, status === "processing" ? "解析中" : "排队中");
      }

      this.setLine(job, "保存中");
      const resultResp = await this.fetchWithTimeout(
        `${apiUrl}/tasks/${taskId}/result`,
        { method: "GET" },
        LOCAL_API_TIMEOUT,
      );
      if (!resultResp.ok)
        throw new Error(`router result HTTP ${resultResp.status}`);
      if (this.responseLooksLikeJSON(resultResp)) {
        throw new Error("router returned JSON, expected ZIP");
      }
      await this.saveLocalZipResult(job, resultResp);
      job.saved = true;
      this.setLine(job, "完成", "done");
    } catch (e) {
      job.errMsg = this.errorMessage(e);
      this.setLine(job, this.short(job.errMsg, 40), "error");
    } finally {
      job.finished = true;
    }
  }

  private async saveZipResult(
    job: ConversionJob,
    zipUrl: string,
  ): Promise<void> {
    if (!zipUrl) throw new Error("no result zip URL");
    const tmpDir = this.jobTmpDir(job);
    await IOUtils.makeDirectory(tmpDir, {
      createAncestors: true,
      ignoreExisting: true,
    });
    const zipPath = PathUtils.join(tmpDir, "result.zip");
    const outputPath = PathUtils.join(tmpDir, job.outputName);

    const resp = await this.fetch(zipUrl, { method: "GET" });
    if (!resp.ok)
      throw new Error(`result download failed (HTTP ${resp.status})`);
    await IOUtils.write(zipPath, new Uint8Array(await resp.arrayBuffer()));

    if (job.outputFormat === "html") {
      await this.saveHTMLFromZip(job, zipPath, outputPath, tmpDir);
    } else {
      await this.extractMarkdownFromZip(zipPath, outputPath);
      await this.importAttachment(job, outputPath, tmpDir);
    }
  }

  private async saveLightResult(
    job: ConversionJob,
    markdownUrl: string,
  ): Promise<void> {
    if (!markdownUrl) throw new Error("no markdown URL");
    const tmpDir = this.jobTmpDir(job);
    await IOUtils.makeDirectory(tmpDir, {
      createAncestors: true,
      ignoreExisting: true,
    });
    const outputPath = PathUtils.join(tmpDir, job.outputName);
    const resp = await this.fetch(markdownUrl, { method: "GET" });
    if (!resp.ok)
      throw new Error(`result download failed (HTTP ${resp.status})`);
    const markdown = await resp.text();
    if (job.outputFormat === "html") {
      await IOUtils.writeUTF8(
        outputPath,
        renderMarkdownToHTML(markdown, job.outputName.replace(/\.html$/i, "")),
      );
    } else {
      await IOUtils.writeUTF8(outputPath, markdown);
    }
    await this.importAttachment(job, outputPath, tmpDir);
  }

  private async saveLocalZipResult(
    job: ConversionJob,
    resp: Response,
  ): Promise<void> {
    const tmpDir = this.jobTmpDir(job);
    await IOUtils.makeDirectory(tmpDir, {
      createAncestors: true,
      ignoreExisting: true,
    });
    const zipPath = PathUtils.join(tmpDir, "result.zip");
    const outputPath = PathUtils.join(tmpDir, job.outputName);
    const imagesDir = PathUtils.join(tmpDir, "images");
    await IOUtils.makeDirectory(imagesDir, {
      createAncestors: true,
      ignoreExisting: true,
    });
    await IOUtils.write(zipPath, new Uint8Array(await resp.arrayBuffer()));

    if (job.outputFormat === "html") {
      await this.saveHTMLFromZip(job, zipPath, outputPath, tmpDir);
      return;
    }

    await this.extractMarkdownFromZip(zipPath, outputPath, imagesDir);
    const hasImages = (await this.countFiles(imagesDir)) > 0;
    const att = await this.importAttachment(job, outputPath, tmpDir, false);
    if (hasImages) {
      const copied = await this.copyCompanionImages(att, imagesDir);
      this.log(`${job.pdfName}: copied ${copied} image(s)`);
    }
    await this.removeTemp(tmpDir);
  }

  private async saveHTMLFromZip(
    job: ConversionJob,
    zipPath: string,
    htmlPath: string,
    tmpDir: string,
  ): Promise<void> {
    try {
      const html = await renderMarkdownZipToHTML(
        zipPath,
        job.outputName.replace(/\.html$/i, ""),
      );
      await IOUtils.writeUTF8(htmlPath, html);
    } catch (e) {
      this.log(
        `Markdown-first HTML generation failed: ${this.errorMessage(e)}`,
      );
      await this.extractHTMLFromZip(zipPath, htmlPath);
    }
    await this.importAttachment(job, htmlPath, tmpDir);
  }

  private async extractMarkdownFromZip(
    zipPath: string,
    mdPath: string,
    imagesDir?: string,
  ): Promise<void> {
    const zr = Components.classes[
      "@mozilla.org/libjar/zip-reader;1"
    ].createInstance(Components.interfaces.nsIZipReader);
    zr.open(Zotero.File.pathToFile(zipPath));
    try {
      let mdEntry = "";
      const imageEntries: string[] = [];
      const entries = zr.findEntries("*");
      while (entries.hasMore()) {
        const entry = entries.getNext();
        const normalized = String(entry).replace(/\\/g, "/");
        if (normalized.includes("/images/")) imageEntries.push(entry);
        if (!normalized.toLowerCase().endsWith(".md")) continue;
        if (
          !mdEntry ||
          normalized.endsWith("/paper.md") ||
          normalized.endsWith("/full.md")
        ) {
          mdEntry = entry;
        }
      }
      if (!mdEntry) throw new Error("markdown not in result zip");
      zr.extract(mdEntry, Zotero.File.pathToFile(mdPath));

      if (imagesDir) {
        for (const entry of imageEntries) {
          const rel = this.zipImageRelativePath(entry);
          if (!rel) continue;
          const dest = PathUtils.join(imagesDir, ...rel.split("/"));
          await IOUtils.makeDirectory(PathUtils.parent(dest), {
            createAncestors: true,
            ignoreExisting: true,
          });
          try {
            zr.extract(entry, Zotero.File.pathToFile(dest));
          } catch (e) {
            this.log(`Image extract skipped: ${this.errorMessage(e)}`);
          }
        }
      }
    } finally {
      zr.close();
    }
  }

  private async extractHTMLFromZip(
    zipPath: string,
    htmlPath: string,
  ): Promise<void> {
    const zr = Components.classes[
      "@mozilla.org/libjar/zip-reader;1"
    ].createInstance(Components.interfaces.nsIZipReader);
    zr.open(Zotero.File.pathToFile(zipPath));
    try {
      const htmlEntries: string[] = [];
      const entries = zr.findEntries("*");
      while (entries.hasMore()) {
        const entry = entries.getNext();
        if (/\.html?$/i.test(String(entry))) htmlEntries.push(entry);
      }
      if (!htmlEntries.length) throw new Error("HTML not in result zip");
      const selected =
        htmlEntries.find((e) => /(^|\/)(main|full)\.html?$/i.test(e)) ||
        htmlEntries[0];
      zr.extract(selected, Zotero.File.pathToFile(htmlPath));
    } finally {
      zr.close();
    }
  }

  private async importAttachment(
    job: ConversionJob,
    filePath: string,
    tmpDir: string,
    cleanup = true,
  ): Promise<Zotero.Item> {
    const options: Record<string, any> = {
      file: filePath,
      contentType: job.contentType,
      charset: "utf-8",
      title: job.outputName,
    };
    if (job.parent) {
      options.parentItemID = job.parent.id;
    } else {
      options.libraryID = job.att.libraryID;
      const cols = job.att.getCollections();
      if (cols.length) options.collections = cols;
    }
    const att = await (Zotero.Attachments as any).importFromFile(options);
    await this.tagConversionResult(att, job.parent);
    if (cleanup) await this.removeTemp(tmpDir);
    return att;
  }

  private async tagConversionResult(
    attachment: Zotero.Item,
    parentItem: Zotero.Item | null,
  ): Promise<void> {
    try {
      attachment.addTag(ATTACHMENT_TAG, 0);
      await attachment.saveTx();
      if (parentItem) {
        parentItem.addTag(PARENT_TAG, 0);
        await parentItem.saveTx();
      }
    } catch (e) {
      this.log(`Tagging converted item failed: ${this.errorMessage(e)}`);
    }
  }

  async exportSelected(win: ZoteroWindow, alwaysAsk: boolean): Promise<void> {
    const items = this.getSelectedItems(win);
    if (!items.length) {
      win.alert("未选择条目。");
      return;
    }

    const atts: Zotero.Item[] = [];
    const seen = new Set<number>();
    const push = (a?: Zotero.Item | false) => {
      if (a && a.isAttachment() && !seen.has(a.id)) {
        seen.add(a.id);
        atts.push(a);
      }
    };
    for (const item of items) {
      if (item.isAttachment()) push(item);
      else if (item.isRegularItem()) {
        for (const id of item.getAttachments()) push(Zotero.Items.get(id));
      }
    }

    const files: Array<{ att: Zotero.Item; path: string; type: string }> = [];
    let missing = 0;
    for (const att of atts) {
      try {
        const path = await att.getFilePathAsync();
        if (path) {
          const name = PathUtils.filename(path);
          const dot = name.lastIndexOf(".");
          files.push({
            att,
            path,
            type: dot > 0 ? name.slice(dot + 1).toLowerCase() : "other",
          });
        } else {
          missing++;
        }
      } catch {
        missing++;
      }
    }
    if (!files.length) {
      win.alert("没有可导出的本地附件文件。");
      return;
    }

    const chosen = this.chooseExportFiles(win, files);
    if (!chosen) return;

    let dir = String(getPref("exportDir") || "").trim();
    let needAsk = alwaysAsk || !dir;
    if (!needAsk && !(await IOUtils.exists(dir))) needAsk = true;
    if (needAsk) {
      dir = await this.pickFolder(win, dir);
      if (!dir) return;
    }

    const perItem = !!getPref("exportPerItem");
    let copied = 0;
    const errors: string[] = [];
    for (const { att, path } of chosen) {
      try {
        let destDir = dir;
        if (perItem) {
          const parent = att.parentItem;
          destDir = PathUtils.join(
            dir,
            this.sanitize(parent ? parent.getDisplayTitle() : "无父条目"),
          );
          await IOUtils.makeDirectory(destDir, {
            ignoreExisting: true,
            createAncestors: true,
          });
        }
        const dest = await this.uniquePath(
          PathUtils.join(destDir, PathUtils.filename(path)),
        );
        await IOUtils.copy(path, dest);
        copied++;
      } catch (e) {
        errors.push(`${PathUtils.filename(path)}: ${this.errorMessage(e)}`);
      }
    }

    const lines = [`已导出 ${copied} 个文件`, dir];
    if (missing) lines.push(`${missing} 个附件不在本地磁盘`);
    if (errors.length) {
      lines.push(`${errors.length} 个导出失败,详情见调试日志`);
      this.log(`Export errors:\n  ${errors.join("\n  ")}`);
    }
    this.toast(lines, 5000);
    try {
      await Zotero.File.reveal(dir);
    } catch {}
  }

  async chooseExportFolderFromPrefs(win: Window): Promise<void> {
    const dir = await this.pickFolder(
      win as ZoteroWindow,
      String(getPref("exportDir") || ""),
    );
    if (!dir) return;
    setPref("exportDir", dir);
    const input = win.document.getElementById(
      `zotero-prefpane-${config.addonRef}-export-dir`,
    ) as HTMLInputElement | null;
    if (input) input.value = dir;
  }

  async testLocalApiFromPrefs(win: Window): Promise<void> {
    const btn = win.document.getElementById(
      `zotero-prefpane-${config.addonRef}-local-test`,
    ) as HTMLButtonElement | null;
    const status = win.document.getElementById(
      `zotero-prefpane-${config.addonRef}-local-test-status`,
    );
    const setStatus = (text: string, ok: boolean) => {
      if (!status) return;
      status.setAttribute("value", text);
      (status as HTMLElement).style.color = ok ? "#1d6e36" : "#b03232";
    };
    try {
      if (btn) btn.disabled = true;
      setStatus("测试中...", true);
      const input = win.document.getElementById(
        `zotero-prefpane-${config.addonRef}-local-api-url`,
      ) as HTMLInputElement | null;
      const rawUrl = String(
        input?.value || getPref("localApiUrl") || "",
      ).trim();
      const apiUrl = rawUrl.replace(/\/+$/, "");
      if (!apiUrl) throw new Error("请先填写 API 地址");
      let resp = await (win as Window).fetch(`${apiUrl}/health`, {
        method: "GET",
      });
      if (!resp.ok) {
        resp = await (win as Window).fetch(`${apiUrl}/openapi.json`, {
          method: "GET",
        });
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      let data: any = null;
      try {
        data = await resp.json();
      } catch {}
      const servers = Array.isArray(data?.servers) ? data.servers : [];
      const healthy = servers.filter((s: any) => s?.healthy).length;
      setStatus(
        servers.length
          ? `连接正常: ${healthy}/${servers.length} 个 worker 可用`
          : "连接正常",
        true,
      );
    } catch (e) {
      setStatus(`测试失败: ${this.errorMessage(e)}`, false);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  private chooseExportFiles(
    win: ZoteroWindow,
    files: Array<{ att: Zotero.Item; path: string; type: string }>,
  ): Array<{ att: Zotero.Item; path: string; type: string }> | null {
    const byType = new Map<string, number>();
    for (const f of files) byType.set(f.type, (byType.get(f.type) || 0) + 1);
    if (byType.size <= 1) return files;

    const types = [...byType.entries()].sort((a, b) => b[1] - a[1]);
    const last = String(getPref("exportLastType") || "");
    const list: string[] = [];
    const mapping: string[] = [];
    if (last && byType.has(last)) {
      list.push(`${last} (${byType.get(last)})`);
      mapping.push(last);
    }
    list.push(`全部 (${files.length})`);
    mapping.push("");
    for (const [type, count] of types) {
      if (type === last) continue;
      list.push(`${type} (${count})`);
      mapping.push(type);
    }
    const sel = { value: 0 };
    if (!Services.prompt.select(win, "导出附件", "文件类型:", list, sel)) {
      return null;
    }
    const pick = mapping[sel.value];
    setPref("exportLastType", pick);
    return pick ? files.filter((f) => f.type === pick) : files;
  }

  private bindFolderPicker(win: Window): void {
    const button = win.document.getElementById(
      `zotero-prefpane-${config.addonRef}-export-choose`,
    );
    if (!button || button.hasAttribute("data-pdf2md-wired")) return;
    button.setAttribute("data-pdf2md-wired", "1");
    button.addEventListener("command", () =>
      this.chooseExportFolderFromPrefs(win).catch((e) =>
        this.log(`Choose folder failed: ${this.errorMessage(e)}`),
      ),
    );
  }

  private bindLocalApiTest(win: Window): void {
    const button = win.document.getElementById(
      `zotero-prefpane-${config.addonRef}-local-test`,
    );
    if (!button || button.hasAttribute("data-pdf2md-wired")) return;
    button.setAttribute("data-pdf2md-wired", "1");
    button.addEventListener("command", () =>
      this.testLocalApiFromPrefs(win).catch((e) =>
        this.log(`Local API test failed: ${this.errorMessage(e)}`),
      ),
    );
  }

  private hasProcessableSelection(items: Zotero.Item[]): boolean {
    return items.some((item) => {
      if (item.isAttachment()) return true;
      if (!item.isRegularItem()) return false;
      return item.getAttachments().some((id) => {
        const att = Zotero.Items.get(id);
        return !!att?.isAttachment?.();
      });
    });
  }

  private getSelectedItems(win: ZoteroWindow): Zotero.Item[] {
    return win.ZoteroPane.getSelectedItems();
  }

  private isPDFAttachment(item?: Zotero.Item | false): item is Zotero.Item {
    if (!item || !item.isAttachment()) return false;
    try {
      if (item.isPDFAttachment()) return true;
    } catch {}
    return item.attachmentContentType === "application/pdf";
  }

  private countParentPDFAttachments(parent: Zotero.Item): number {
    return parent
      .getAttachments()
      .filter((id) => this.isPDFAttachment(Zotero.Items.get(id))).length;
  }

  private hasOutputAttachment(
    parent: Zotero.Item,
    outputName: string,
  ): boolean {
    for (const id of parent.getAttachments()) {
      const att = Zotero.Items.get(id);
      if (!att?.isAttachment()) continue;
      if (
        att.attachmentFilename === outputName ||
        att.getField("title") === outputName
      ) {
        return true;
      }
    }
    return false;
  }

  private outputName(
    parent: Zotero.Item | null,
    pdfName: string,
    includePDFName: boolean,
    outputFormat: OutputFormat,
  ): string {
    let base = "";
    if (parent) {
      base = parent.getDisplayTitle() || String(parent.getField("title") || "");
    }
    if (!base) base = String(pdfName || "").replace(/\.pdf$/i, "");
    if (parent && includePDFName) {
      base += ` - ${String(pdfName || "").replace(/\.pdf$/i, "")}`;
    }
    return `${this.sanitize(base)}.${outputFormat === "html" ? "html" : "md"}`;
  }

  private label(item: Zotero.Item): string {
    try {
      return item.getDisplayTitle();
    } catch {
      return `item ${item.id}`;
    }
  }

  private stateText(r: any): string {
    const state = String(r?.state || r?.status || "");
    if (state === "waiting-file") return "等待文件";
    if (state === "pending") return "排队中";
    if (
      state === "running" ||
      state === "converting" ||
      state === "processing"
    ) {
      return "解析中";
    }
    return state || "处理中";
  }

  private setLine(
    job: ConversionJob,
    status: string,
    kind?: "done" | "error",
  ): void {
    this.statusLine(
      job.dataId,
      `• ${this.short(job.pdfName)}: ${status}`,
      kind,
    );
  }

  private statusShow(headline: string): void {
    const win = Zotero.getMainWindow() as ZoteroWindow | null;
    if (!win) return;
    this.statusCancelTimer();
    let s = this.status;
    if (!s || !s.el.isConnected || s.win !== win) {
      s?.el.remove();
      const doc = win.document;
      const el = doc.createElementNS(HTML_NS, "div");
      el.id = `${config.addonRef}-status`;
      el.style.cssText =
        "position:fixed;right:14px;bottom:14px;z-index:99999;background:canvas;" +
        "color:canvastext;border:1px solid color-mix(in srgb, canvastext 25%, transparent);" +
        "border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.3);padding:9px 12px;" +
        "font:menu;max-width:360px;cursor:default;user-select:none;";
      const headWrap = doc.createElementNS(HTML_NS, "div");
      headWrap.style.cssText = "display:flex;align-items:center;gap:10px;";
      const head = doc.createElementNS(HTML_NS, "div");
      head.style.cssText =
        "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.5;font-weight:600;flex:1;";
      const close = doc.createElementNS(HTML_NS, "div");
      close.textContent = "x";
      close.style.cssText = "cursor:pointer;opacity:.55;";
      close.addEventListener("click", () => {
        el.hidden = true;
      });
      headWrap.append(head, close);
      const list = doc.createElementNS(HTML_NS, "div");
      list.style.cssText = "max-height:40vh;overflow-y:auto;";
      const note = doc.createElementNS(HTML_NS, "div");
      note.style.cssText =
        "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.5;opacity:.65;";
      note.hidden = true;
      el.append(headWrap, list, note);
      doc.documentElement.appendChild(el);
      s = this.status = {
        win,
        el,
        head,
        list,
        note,
        rows: new Map(),
        timer: null,
      };
    }
    s.rows.clear();
    s.list.replaceChildren();
    s.note.hidden = true;
    s.el.hidden = false;
    s.head.textContent = headline;
  }

  private statusHeadline(text: string): void {
    if (this.status?.el.isConnected) this.status.head.textContent = text;
  }

  private statusLine(key: string, text: string, kind?: "done" | "error"): void {
    const s = this.status;
    if (!s?.el.isConnected) return;
    let row = s.rows.get(key);
    if (!row) {
      row = s.win.document.createElementNS(HTML_NS, "div");
      row.style.cssText =
        "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.5;";
      s.list.appendChild(row);
      s.rows.set(key, row);
    }
    row.textContent = text;
    row.style.color = kind === "error" ? "#e35d5d" : "";
    row.style.opacity = kind === "done" ? ".65" : "";
  }

  private statusNote(text: string): void {
    if (!this.status?.el.isConnected) return;
    this.status.note.textContent = text;
    this.status.note.hidden = false;
  }

  private statusClose(delay: number): void {
    const s = this.status;
    if (!s) return;
    this.statusCancelTimer();
    s.timer = s.win.setTimeout(() => {
      s.el.remove();
      if (this.status === s) this.status = null;
    }, delay);
  }

  private statusCancelTimer(): void {
    const s = this.status;
    if (s?.timer) {
      s.win.clearTimeout(s.timer);
      s.timer = null;
    }
  }

  private toast(lines: string[], duration = 4000): void {
    const win = Zotero.getMainWindow() as ZoteroWindow | null;
    if (!win) return;
    const doc = win.document;
    const el = doc.createElementNS(HTML_NS, "div");
    el.className = `${config.addonRef}-toast`;
    el.style.cssText =
      "position:fixed;right:14px;bottom:14px;z-index:99999;background:canvas;" +
      "color:canvastext;border:1px solid color-mix(in srgb, canvastext 25%, transparent);" +
      "border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.3);padding:9px 12px;" +
      "font:menu;max-width:360px;cursor:pointer;user-select:none;";
    const st = this.status;
    if (st?.el.isConnected && !st.el.hidden) {
      el.style.bottom = `${14 + st.el.getBoundingClientRect().height + 10}px`;
    }
    for (const [i, text] of lines.entries()) {
      const d = doc.createElementNS(HTML_NS, "div");
      d.style.cssText =
        "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.5;" +
        (i === 0 ? "font-weight:600;" : "");
      d.textContent = text;
      el.appendChild(d);
    }
    el.addEventListener("click", () => el.remove());
    doc.documentElement.appendChild(el);
    win.setTimeout(() => el.remove(), duration);
  }

  private async pickFolder(
    win: ZoteroWindow,
    startDir: string,
  ): Promise<string> {
    const nsIFilePicker = Components.interfaces.nsIFilePicker;
    const fp =
      Components.classes["@mozilla.org/filepicker;1"].createInstance(
        nsIFilePicker,
      );
    if (Zotero.platformMajorVersion >= 120) {
      fp.init(win.browsingContext, "选择文件夹", nsIFilePicker.modeGetFolder);
    } else {
      fp.init(win, "选择文件夹", nsIFilePicker.modeGetFolder);
    }
    if (startDir) {
      try {
        fp.displayDirectory = Zotero.File.pathToFile(startDir);
      } catch {}
    }
    const rv = await new Promise<number>((resolve) => fp.open(resolve));
    if (rv !== nsIFilePicker.returnOK) return "";
    return fp.file.path;
  }

  private async uniquePath(dest: string): Promise<string> {
    if (!(await IOUtils.exists(dest))) return dest;
    const dir = PathUtils.parent(dest);
    const name = PathUtils.filename(dest);
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    for (let i = 2; i < 1000; i++) {
      const cand = PathUtils.join(dir, `${base} (${i})${ext}`);
      if (!(await IOUtils.exists(cand))) return cand;
    }
    throw new Error(`no unique name for ${dest}`);
  }

  private sanitize(name: string): string {
    let out = "";
    try {
      out = Zotero.File.getValidFileName(name);
    } catch {
      out = String(name).replace(/[\\/:*?"<>|]/g, "_");
    }
    out = out.trim().slice(0, 100).trim();
    return out || "Untitled";
  }

  private async api(
    method: string,
    url: string,
    body: unknown,
    token: string,
  ): Promise<any> {
    const opts: RequestInit = {
      method,
      headers: { Accept: "*/*" },
    };
    if (token)
      (opts.headers as Record<string, string>).Authorization =
        `Bearer ${token}`;
    if (body) {
      (opts.headers as Record<string, string>)["Content-Type"] =
        "application/json";
      opts.body = JSON.stringify(body);
    }
    const resp = await this.fetch(url, opts);
    let json: any = null;
    try {
      json = await resp.json();
    } catch {}
    if (!resp.ok) {
      throw new Error(
        `MinerU HTTP ${resp.status}${json?.msg ? `: ${json.msg}` : ""}`,
      );
    }
    if (!json || json.code !== 0) {
      throw new Error(
        `MinerU error ${json ? `${json.code}: ${json.msg}` : "(bad response)"}`,
      );
    }
    return json.data;
  }

  private fetch(url: string, opts?: RequestInit): Promise<Response> {
    return this.mainWindow().fetch(url, opts);
  }

  private async fetchWithTimeout(
    url: string,
    opts: RequestInit,
    timeout: number,
  ): Promise<Response> {
    const win = this.mainWindow();
    if (!timeout || !win.AbortController) return win.fetch(url, opts);
    const controller = new win.AbortController();
    const timer = win.setTimeout(() => controller.abort(), timeout);
    try {
      return await win.fetch(url, { ...opts, signal: controller.signal });
    } finally {
      win.clearTimeout(timer);
    }
  }

  private localApiUrl(): string {
    const apiUrl = String(getPref("localApiUrl") || "").replace(/\/+$/, "");
    if (!apiUrl) throw new Error("local API URL not configured");
    return apiUrl;
  }

  private localFormData(bytes: Uint8Array, filename: string): FormData {
    const win = this.mainWindow();
    const formData = new win.FormData();
    const blob = new win.Blob([bytes], { type: "application/pdf" });
    if (win.File) {
      formData.append(
        "files",
        new win.File([blob], filename, { type: "application/pdf" }),
      );
    } else {
      formData.append("files", blob, filename);
    }
    return formData;
  }

  private responseLooksLikeJSON(resp: Response): boolean {
    return String(resp.headers.get("content-type") || "")
      .toLowerCase()
      .includes("json");
  }

  private jobTmpDir(job: ConversionJob): string {
    return PathUtils.join(
      Zotero.getTempDirectory().path,
      `${config.addonRef}-${job.dataId}-${Date.now()}`,
    );
  }

  private zipImageRelativePath(entry: string): string {
    const normalized = entry.replace(/\\/g, "/");
    const marker = "/images/";
    const idx = normalized.indexOf(marker);
    if (idx < 0) return "";
    const rel = normalized.slice(idx + marker.length).replace(/^\/+/, "");
    if (
      !rel ||
      rel.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      return "";
    }
    return rel;
  }

  private async copyCompanionImages(
    att: Zotero.Item,
    imagesDir: string,
  ): Promise<number> {
    const mdPath = att.getFilePath();
    if (!mdPath || !(await IOUtils.exists(imagesDir))) return 0;
    const destDir = PathUtils.join(PathUtils.parent(mdPath), "images");
    await IOUtils.remove(destDir, { recursive: true, ignoreAbsent: true });
    await IOUtils.makeDirectory(destDir, {
      createAncestors: true,
      ignoreExisting: true,
    });
    await this.copyDirectoryFiles(imagesDir, destDir);
    return this.countFiles(destDir);
  }

  private async copyDirectoryFiles(
    sourceDir: string,
    destDir: string,
  ): Promise<void> {
    for (const child of await IOUtils.getChildren(sourceDir)) {
      const dest = PathUtils.join(destDir, PathUtils.filename(child));
      const info = await IOUtils.stat(child);
      if (info.type === "directory") {
        await IOUtils.makeDirectory(dest, {
          createAncestors: true,
          ignoreExisting: true,
        });
        await this.copyDirectoryFiles(child, dest);
      } else {
        await IOUtils.copy(child, dest);
      }
    }
  }

  private async countFiles(dir: string): Promise<number> {
    if (!(await IOUtils.exists(dir))) return 0;
    let count = 0;
    for (const child of await IOUtils.getChildren(dir)) {
      const info = await IOUtils.stat(child);
      count += info.type === "directory" ? await this.countFiles(child) : 1;
    }
    return count;
  }

  private async removeTemp(tmpDir: string): Promise<void> {
    try {
      await IOUtils.remove(tmpDir, { recursive: true, ignoreAbsent: true });
    } catch (e) {
      this.log(`Temp cleanup deferred: ${this.errorMessage(e)}`);
    }
  }

  private getIntPref(
    key: keyof _ZoteroTypes.Prefs["PluginPrefsMap"],
    fallback: number,
    min: number,
    max: number,
  ): number {
    let value = parseInt(String(getPref(key)), 10);
    if (!Number.isFinite(value)) value = fallback;
    return Math.min(max, Math.max(min, value));
  }

  private mainWindow(): ZoteroWindow {
    const win = Zotero.getMainWindow() as ZoteroWindow | null;
    if (!win) throw new Error("no Zotero window available");
    return win;
  }

  private short(name: string, max = 32): string {
    const text = String(name || "");
    if (text.length <= max) return text;
    return `${text.slice(0, Math.max(0, max - 1))}…`;
  }

  private errorMessage(e: any): string {
    return String(e?.message || e || "Unknown error");
  }

  private log(msg: string): void {
    ztoolkit.log(`PDF2MD: ${msg}`);
  }
}
