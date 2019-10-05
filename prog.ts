import * as url from 'url';
import * as path from 'path';
import { promises as fs } from 'fs';
import * as querystring from 'querystring';

import * as request from 'request-promise-native';
import { CookieJar } from 'request';
import { JSDOM } from 'jsdom';

interface ProgrammerMagazineLink {
  id: string;
  url: string;
  filename: string;
}

class ProgrammerMagazineScraper {
  private _maxRequests = 3;

  private cookieJar: CookieJar = request.jar();

  private runningRequests = 0;
  public requestsList: { started: boolean, scrape: () => Promise<void> }[] = [];

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

  public async scrape(skipExisting = true): Promise<void> {
    for (const link of await this.getLinks()) {
      const magazinefolder = path.join(__dirname, 'magazines', link.id);
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

      this.startNext();
    }
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
        console.log(filebase, 'ok');
      } catch (err) {
        console.log(filebase, err.message);
      } finally {
        this.runningRequests--;
        this.startNext();
      }
    };
  }
}

(async () => {
  const username = process.env.USERNAME;
  const password = process.env.PASSWORD;

  if (!username || !password) {
    console.log('Please set enviromental variables');
    return;
  }
  try {
    const scraper = new ProgrammerMagazineScraper(username, password);
    scraper.maxRequests = 5;
    scraper.scrape();
  } catch (err) {
    console.log(err);
  }
})();
