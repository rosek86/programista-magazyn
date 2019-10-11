import * as url from 'url';
import * as path from 'path';
import { promises as fs, createReadStream } from 'fs';
import * as querystring from 'querystring';

import * as request from 'request-promise-native';
import { CookieJar } from 'request';
import { JSDOM } from 'jsdom';

import { WebClient } from '@slack/web-api';

interface ProgrammerMagazineLink {
  id: string;
  url: string;
  filename: string;
}

class ProgrammerMagazineScraper {
  private _maxRequests = 3;

  private cookieJar: CookieJar = request.jar();

  private runningRequests = 0;
  private completedRequests = 0;
  private requestsList: { started: boolean, scrape: () => Promise<void> }[] = [];
  private allRequestsCompleted: () => void = () => {};

  private newMagazines: string[] = [];

  constructor(private username: string, private password: string) {
  }

  public get maxRequests(): number {
    return this._maxRequests;
  }

  public set maxRequests(requests: number) {
    this._maxRequests = requests;
  }

  public get jar(): CookieJar {
    return this.cookieJar;
  }

  public async getLinks(): Promise<ProgrammerMagazineLink[]> {
    const results: ProgrammerMagazineLink[] = [];

    const dom = await this.getMyMagazinesDom();

    for (const section of this.getMagazinesSections(dom)) {
      if (!section.id) { continue; }

      const linksTables = this.getMagazineLinksTable(section);
      if (linksTables.length === 0) { continue; }
      const linksTable = linksTables[0];

      for (const format of this.getMagazineLinks(linksTable)) {
        const urlParsed = url.parse(format.href);
        if (!urlParsed.path || !urlParsed.href) {
          continue;
        }

        const ext = path.extname(urlParsed.path);
        if (ext === '') {
          continue;
        }

        results.push({
          id: section.id,
          url: urlParsed.href,
          filename: decodeURI(path.basename(urlParsed.path)),
        });
      }
    }

    return results;
  }

  private async getMyMagazinesDom(): Promise<JSDOM> {
    const formData = querystring.stringify({
      log: this.username, pwd: this.password,
    });

    const loginResult = await request.post({
      headers: {
        'Content-Length': formData.length,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      uri: 'https://programistamag.pl/login/',
      body: formData,
      jar: this.cookieJar,
      resolveWithFullResponse: true,
      followAllRedirects: true,
      timeout: 20 * 1000,
    });

    return new JSDOM(loginResult.body);
  }

  private getMagazinesSections(dom: JSDOM): HTMLCollectionOf<Element> {
    return dom.window.document.getElementsByClassName('section-magazine');
  }

  private getMagazineLinksTable(section: Element): HTMLCollectionOf<Element> {
    return section.getElementsByClassName('borderless');
  }

  private getMagazineLinks(table: Element): HTMLCollectionOf<HTMLAnchorElement> {
    return table.getElementsByTagName('a');
  }

  public async scrape(directory = '', skipExisting = true): Promise<string[]> {
    this.scrapeInit();

    console.log('Downloading magazines list...');
    const links = await this.getLinks();

    console.log('Downloading magazines...');
    for (const link of links) {
      let baseFolder = path.join(__dirname, 'programista');
      if (directory !== '') {
        baseFolder = directory;
      }
      const magazinefolder = path.join(baseFolder, link.id);
      const filename = path.join(magazinefolder, link.filename);

      if (skipExisting) {
        try {
          await fs.access(filename);
          continue;
        } catch (err) {
          // ok
        }
      }

      this.requestsList.push({
        started: false,
        scrape: this.scraperFactory(link.url, magazinefolder, filename),
      });
    }

    const waitAllPromises = new Promise<void>((resolve) => {
      this.allRequestsCompleted = resolve;
    });
    this.startNext();

    await waitAllPromises;
    return this.newMagazines;
  }

  private scrapeInit(): void {
    this.runningRequests = 0;
    this.completedRequests = 0;
    this.requestsList = [];
    this.allRequestsCompleted = () => {};
    this.newMagazines = [];
  }

  private startNext(): void {
    for (const req of this.requestsList) {
      if (this.runningRequests >= this.maxRequests) {
        return;
      }
      if (req.started === true) {
        continue;
      }

      req.started = true;
      req.scrape();

      ++this.runningRequests;
    }

    if (this.completedRequests >= this.requestsList.length) {
      this.allRequestsCompleted();
    }
  }

  private scraperFactory(uri: string, folder: string, filename: string): () => Promise<void> {
    const filebase = path.basename(filename);
    return async () => {
      try {
        console.log(filebase, 'started');
        const content = await request.get({
          uri,
          jar: this.jar,
          followAllRedirects: true,
          encoding: null,
        });
        await fs.mkdir(folder, { recursive: true });
        await fs.writeFile(filename, content);
        this.newMagazines.push(filename);
        console.log(filebase, 'ok');
      } catch (err) {
        console.log(filebase, err.message);
      } finally {
        this.runningRequests--;
        this.completedRequests++;
        this.startNext();
      }
    };
  }
}

(async () => {
  const username = process.env.USERNAME;
  const password = process.env.PASSWORD;

  const slackToken    = process.env.SLACK_TOKEN;
  const slackChannels = process.env.SLACK_CHANNELS;
  
  if (!username || !password) {
    console.log('Please set enviromental variables');
    return;
  }

  let directory = '';
  if (process.argv.length === 3) {
    directory = process.argv[2];
  }

  try {
    const scraper = new ProgrammerMagazineScraper(username, password);
    scraper.maxRequests = 5;

    const newMagazines = await scraper.scrape(directory);
    console.log('complete');
    console.log('new magazines:', JSON.stringify(newMagazines, null, 2));

    if (slackToken && slackChannels) {
      await uploadNewMagazines(slackToken, slackChannels, newMagazines);
    }
  } catch (err) {
    console.log(err);
  }
})();

async function uploadNewMagazines(slackToken: string, slackChannels: string, magazines: string[]): Promise<void> {
  const pdfMagazines = magazines.filter((m) => m.match(/.+\.pdf$/) !== null);

  if (pdfMagazines.length === 0) {
    return;
  }

  const web = new WebClient(slackToken);

  for (const file of pdfMagazines) {
    const filebase = path.basename(file);
    console.log(`> Uploading file... ${filebase}`);
    await web.files.upload({
      filename: filebase,
      file:     createReadStream(file),
      channels: slackChannels,
    });

    console.log(`File uploaded`);
  }
}