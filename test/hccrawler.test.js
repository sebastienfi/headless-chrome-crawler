const { unlink, readFile, existsSync } = require('fs');
const assert = require('assert');
const sinon = require('sinon');
const { extend, includes, noop } = require('lodash');
const HCCrawler = require('../');
const RedisCache = require('../cache/redis');
const CSVExporter = require('../exporter/csv');
const JSONLineExporter = require('../exporter/json-line');
const Server = require('./server');

const PORT = 8080;
const PREFIX = `http://127.0.0.1:${PORT}`;
const INDEX_PAGE = `${PREFIX}/`;
const CSV_FILE = './tmp/result.csv';
const JSON_FILE = './tmp/result.json';
const ENCODING = 'utf8';

const DEFAULT_OPTIONS = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };

describe('HCCrawler', () => {
  describe('HCCrawler.executablePath', () => {
    it('works', () => {
      const executablePath = HCCrawler.executablePath();
      assert.ok(existsSync(executablePath));
    });
  });

  describe('HCCrawler.defaultArgs', () => {
    it('returns the default chrome arguments', () => {
      const args = HCCrawler.defaultArgs();
      assert.ok(includes(args, '--no-first-run'));
    });
  });

  describe('HCCrawler.launch', () => {
    let server;
    let crawler;

    context('when crawling does not fail', () => {
      let onSuccess;

      function evaluatePage() {
        return $('body').text();
      }

      before(() => (
        Server.run(PORT)
          .then(_server => {
            server = _server;
          })
      ));

      after(() => server.stop());

      beforeEach(() => {
        server.reset();
        onSuccess = sinon.spy();
      });

      context('when the crawler is launched with necessary options', () => {
        beforeEach(() => (
          HCCrawler.launch(extend({ onSuccess }, DEFAULT_OPTIONS))
            .then(_crawler => {
              crawler = _crawler;
            })
        ));

        afterEach(() => crawler.close());

        it('shows the browser version', () => (
          crawler.version()
            .then(version => {
              assert.ok(includes(version, 'HeadlessChrome'));
            })
        ));

        it('shows the default user agent', () => (
          crawler.userAgent()
            .then(userAgent => {
              assert.ok(includes(userAgent, 'HeadlessChrome'));
            })
        ));

        it('shows the WebSocket endpoint', () => {
          assert.ok(includes(crawler.wsEndpoint(), 'ws://'));
        });

        it('throws an error when queueing null', () => {
          assert.throws(() => {
            crawler.queue(null);
          });
        });

        it('throws an error when queueing options without URL', () => {
          assert.throws(() => {
            crawler.queue();
          });
        });

        it('crawls when queueing necessary options', () => {
          let requeststarted = 0;
          let requestfinished = 0;
          crawler.on('requeststarted', () => { requeststarted += 1; });
          crawler.on('requestfinished', () => { requestfinished += 1; });
          crawler.queue(INDEX_PAGE);
          return crawler.onIdle()
            .then(() => {
              assert.equal(requeststarted, 1);
              assert.equal(requestfinished, 1);
              assert.equal(crawler.pendingQueueSize(), 0);
              assert.equal(crawler.requestedCount(), 1);
              assert.equal(onSuccess.callCount, 1);
              assert.equal(onSuccess.firstCall.args[0].options.url, INDEX_PAGE);
              assert.ok(onSuccess.firstCall.args[0].response.ok);
              assert.equal(onSuccess.firstCall.args[0].response.status, 200);
              assert.equal(onSuccess.firstCall.args[0].response.url, INDEX_PAGE);
            });
        });

        it('crawls when queueing a string', () => {
          crawler.queue(INDEX_PAGE);
          return crawler.onIdle()
            .then(() => {
              assert.equal(onSuccess.callCount, 1);
            });
        });

        it('crawls when queueing multiple strings', () => {
          crawler.queue([`${PREFIX}/1.html`, `${PREFIX}/2.html`, `${PREFIX}/3.html`]);
          return crawler.onIdle()
            .then(() => {
              assert.equal(onSuccess.callCount, 3);
            });
        });

        it('crawls when queueing an object', () => {
          crawler.queue({ url: INDEX_PAGE });
          return crawler.onIdle()
            .then(() => {
              assert.equal(onSuccess.callCount, 1);
            });
        });

        it('crawls when queueing multiple objects', () => {
          crawler.queue([{ url: `${PREFIX}/1.html` }, { url: `${PREFIX}/2.html` }]);
          return crawler.onIdle()
            .then(() => {
              assert.equal(onSuccess.callCount, 2);
            });
        });

        it('crawls when queueing mixed styles', () => {
          crawler.queue([`${PREFIX}/1.html`, { url: `${PREFIX}/2.html` }]);
          crawler.queue(`${PREFIX}/3.html`);
          return crawler.onIdle()
            .then(() => {
              assert.equal(onSuccess.callCount, 3);
            });
        });

        it('throws an error when overriding onSuccess', () => {
          assert.throws(() => {
            crawler.queue({ url: INDEX_PAGE, onSuccess: noop });
          });
        });

        it('throws an error when queueing options with unavailable device', () => {
          assert.throws(() => {
            crawler.queue({ url: INDEX_PAGE, device: 'do-not-exist' });
          });
        });

        it('throws an error when delay is set', () => {
          assert.throws(() => {
            crawler.queue({ url: INDEX_PAGE, delay: 100 });
          });
        });

        it('crawls when the requested domain is allowed', () => {
          let requestskipped = 0;
          crawler.on('requestskipped', () => { requestskipped += 1; });
          crawler.queue({ url: INDEX_PAGE, allowedDomains: ['127.0.0.1'] });
          return crawler.onIdle()
            .then(() => {
              assert.equal(requestskipped, 0);
              assert.equal(onSuccess.callCount, 1);
            });
        });

        it('skips crawling when the requested domain is not allowed', () => {
          let requestskipped = 0;
          crawler.on('requestskipped', () => { requestskipped += 1; });
          crawler.queue({ url: INDEX_PAGE, allowedDomains: ['0.0.0.0'] });
          return crawler.onIdle()
            .then(() => {
              assert.equal(requestskipped, 1);
              assert.equal(onSuccess.callCount, 0);
            });
        });

        it('follows links when maxDepth is set', () => {
          let maxdepthreached = 0;
          server.setContent('/1.html', `go to <a href="${PREFIX}/2.html">/2.html</a>`);
          crawler.on('maxdepthreached', () => { maxdepthreached += 1; });
          crawler.queue({ url: `${PREFIX}/1.html`, maxDepth: 2 });
          return crawler.onIdle()
            .then(() => {
              assert.equal(maxdepthreached, 1);
              assert.equal(onSuccess.callCount, 2);
              assert.deepEqual(onSuccess.firstCall.args[0].links, [`${PREFIX}/2.html`]);
              assert.equal(onSuccess.secondCall.args[0].depth, 2);
            });
        });

        it('crawls regardless of the alert dialog', () => {
          server.setContent('/', `<script>alert('Welcome to ${INDEX_PAGE}');</script>`);
          crawler.queue(INDEX_PAGE);
          return crawler.onIdle()
            .then(() => {
              assert.equal(onSuccess.callCount, 1);
            });
        });

        it('crawls when the path is allowed by robots.txt', () => {
          server.setContent('/robots.txt', 'User-agent: *\nAllow: /');
          let requestskipped = 0;
          crawler.on('requestskipped', () => { requestskipped += 1; });
          crawler.queue(INDEX_PAGE);
          return crawler.onIdle()
            .then(() => {
              assert.equal(requestskipped, 0);
              assert.equal(onSuccess.callCount, 1);
            });
        });

        it('skips crawling when the path is not allowed by robots.txt', () => {
          server.setContent('/robots.txt', 'User-agent: *\nDisallow: /');
          let requestskipped = 0;
          crawler.on('requestskipped', () => { requestskipped += 1; });
          crawler.queue(INDEX_PAGE);
          return crawler.onIdle()
            .then(() => {
              assert.equal(requestskipped, 1);
              assert.equal(onSuccess.callCount, 0);
            });
        });

        it('stops crawling when allowed and disallowed paths are mixed', () => {
          server.setContent('/robots.txt', 'User-agent: *\nDisallow: /2.html');
          let requestskipped = 0;
          crawler.on('requestskipped', () => { requestskipped += 1; });
          crawler.queue(`${PREFIX}/1.html`);
          crawler.queue(`${PREFIX}/2.html`);
          return crawler.onIdle()
            .then(() => {
              assert.equal(requestskipped, 1);
              assert.equal(onSuccess.callCount, 1);
            });
        });

        it('does not obey robots.txt with obeyRobotsTxt = false', () => {
          server.setContent('/robots.txt', 'User-agent: *\nDisallow: /');
          let requestskipped = 0;
          crawler.on('requestskipped', () => { requestskipped += 1; });
          crawler.queue({ url: INDEX_PAGE, obeyRobotsTxt: false });
          return crawler.onIdle()
            .then(() => {
              assert.equal(requestskipped, 0);
              assert.equal(onSuccess.callCount, 1);
            });
        });


        context('when the page requires basic authentication', () => {
          beforeEach(() => {
            server.setContent('/', 'Authorization succeeded!');
            server.setAuth('/', 'username', 'password');
          });

          it('fails authentication when username and password are not set', () => {
            crawler.queue({
              url: INDEX_PAGE,
              evaluatePage,
            });
            return crawler.onIdle()
              .then(() => {
                assert.equal(onSuccess.callCount, 1);
                assert.equal(onSuccess.firstCall.args[0].result, 'HTTP Error 401 Unauthorized: Access is denied');
              });
          });

          it('fails authentication when wrong username and password are set', () => {
            crawler.queue({
              url: INDEX_PAGE,
              username: 'password',
              password: 'username',
              evaluatePage,
            });
            return crawler.onIdle()
              .then(() => {
                assert.equal(onSuccess.callCount, 1);
                assert.equal(onSuccess.firstCall.args[0].result, 'HTTP Error 401 Unauthorized: Access is denied');
              });
          });

          it('passes authentication when proper username and password are set', () => {
            crawler.queue({
              url: INDEX_PAGE,
              username: 'username',
              password: 'password',
              evaluatePage,
            });
            return crawler.onIdle()
              .then(() => {
                assert.equal(onSuccess.callCount, 1);
                assert.equal(onSuccess.firstCall.args[0].result, 'Authorization succeeded!');
              });
          });
        });

        context('when sitemap.xml is referred by robots.txt', () => {
          beforeEach(() => {
            server.setContent('/robots.txt', `Sitemap: ${PREFIX}/sitemap.xml`);
            server.setContent('/sitemap.xml', `
            <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
              <url>
                <loc>${PREFIX}/2.html</loc>
                <priority>1.0</priority>
              </url>
            </urlset>
            `);
          });

          it('does not follow sitemap.xml', () => {
            crawler.queue(`${PREFIX}/1.html`);
            return crawler.onIdle()
              .then(() => {
                assert.equal(onSuccess.callCount, 1);
              });
          });

          it('follows sitemap.xml with followSitemapXml = true', () => {
            crawler.queue({ url: `${PREFIX}/1.html`, followSitemapXml: true });
            return crawler.onIdle()
              .then(() => {
                assert.equal(onSuccess.callCount, 2);
              });
          });
        });
      });

      context('when page is evaluated by jQuery', () => {
        beforeEach(() => (
          HCCrawler.launch(extend({ onSuccess, evaluatePage, retryCount: 0 }, DEFAULT_OPTIONS))
            .then(_crawler => {
              crawler = _crawler;
            })
        ));

        afterEach(() => crawler.close());

        it('succeeds evaluating page', () => {
          crawler.queue(INDEX_PAGE);
          return crawler.onIdle()
            .then(() => {
              assert.equal(onSuccess.callCount, 1);
              assert.equal(onSuccess.firstCall.args[0].result, '/');
            });
        });

        it('fails evaluating page with jQuery = false', () => {
          crawler.queue({ url: INDEX_PAGE, jQuery: false });
          return crawler.onIdle()
            .then(() => {
              assert.equal(onSuccess.callCount, 0);
            });
        });
      });

      context('when the crawler is launched with device option', () => {
        beforeEach(() => {
          server.setContent('/', '<script>window.document.write(window.navigator.userAgent);</script>');
          return HCCrawler.launch(extend({ onSuccess, evaluatePage, device: 'iPhone 6' }, DEFAULT_OPTIONS))
            .then(_crawler => {
              crawler = _crawler;
            });
        });

        afterEach(() => crawler.close());

        it('modifies userAgent', () => {
          crawler.queue(INDEX_PAGE);
          return crawler.onIdle()
            .then(() => {
              assert.equal(onSuccess.callCount, 1);
              assert.ok(includes(onSuccess.firstCall.args[0].result, 'iPhone'));
            });
        });

        it("overrides device with device = 'Nexus 6'", () => {
          crawler.queue({ url: INDEX_PAGE, device: 'Nexus 6' });
          return crawler.onIdle()
            .then(() => {
              assert.equal(onSuccess.callCount, 1);
              assert.ok(includes(onSuccess.firstCall.args[0].result, 'Nexus 6'));
            });
        });

        it("overrides userAgent with userAgent = 'headless-chrome-crawler'", () => {
          crawler.queue({ url: INDEX_PAGE, userAgent: 'headless-chrome-crawler' });
          return crawler.onIdle()
            .then(() => {
              assert.equal(onSuccess.callCount, 1);
              assert.equal(onSuccess.firstCall.args[0].result, 'headless-chrome-crawler');
            });
        });
      });

      context('when the crawler is launched with maxConcurrency = 1', () => {
        beforeEach(() => (
          HCCrawler.launch(extend({ onSuccess, maxConcurrency: 1 }, DEFAULT_OPTIONS))
            .then(_crawler => {
              crawler = _crawler;
            })
        ));

        afterEach(() => crawler.close());

        it('does not throw an error when delay option is set', () => {
          crawler.queue({ url: INDEX_PAGE, delay: 100 });
          return crawler.onIdle()
            .then(() => {
              assert.equal(onSuccess.callCount, 1);
            });
        });

        it('does not crawl already cached url', () => {
          crawler.queue(`${PREFIX}/1.html`);
          crawler.queue(`${PREFIX}/2.html`);
          crawler.queue(`${PREFIX}/1.html`); // The queue won't be requested
          return crawler.onIdle()
            .then(() => {
              assert.equal(onSuccess.callCount, 2);
            });
        });

        it('obeys priority order', () => {
          crawler.queue({ url: `${PREFIX}/1.html`, priority: 1 });
          crawler.queue({ url: `${PREFIX}/2.html`, priority: 2 });
          return crawler.onIdle()
            .then(() => {
              assert.equal(onSuccess.callCount, 2);
              assert.equal(onSuccess.firstCall.args[0].options.url, `${PREFIX}/2.html`);
              assert.equal(onSuccess.secondCall.args[0].options.url, `${PREFIX}/1.html`);
            });
        });

        it('crawls duplicate urls with skipDuplicates = false', () => {
          crawler.queue({ url: `${PREFIX}/1.html` });
          crawler.queue({ url: `${PREFIX}/2.html` });
          crawler.queue({ url: `${PREFIX}/1.html` });
          crawler.queue({ url: `${PREFIX}/2.html`, skipDuplicates: false }); // The queue will be requested
          return crawler.onIdle()
            .then(() => {
              assert.equal(onSuccess.callCount, 3);
            });
        });
      });

      context('when the crawler is launched with maxRequest option', () => {
        beforeEach(() => (
          HCCrawler.launch(extend({
            onSuccess,
            maxConcurrency: 1,
            maxRequest: 2,
          }, DEFAULT_OPTIONS))
            .then(_crawler => {
              crawler = _crawler;
            })
        ));

        afterEach(() => crawler.close());

        it('pauses at maxRequest option', () => {
          let maxrequestreached = 0;
          crawler.on('maxrequestreached', () => { maxrequestreached += 1; });
          crawler.queue(`${PREFIX}/1.html`);
          crawler.queue(`${PREFIX}/2.html`);
          crawler.queue(`${PREFIX}/3.html`);
          return crawler.onIdle()
            .then(() => {
              assert.equal(maxrequestreached, 1);
              assert.equal(crawler.isPaused(), true);
              assert.equal(onSuccess.callCount, 2);
              return crawler.queueSize();
            })
            .then(size => {
              assert.equal(size, 1);
            });
        });

        it('resumes from maxRequest option', () => {
          crawler.queue(`${PREFIX}/1.html`);
          crawler.queue(`${PREFIX}/2.html`);
          crawler.queue(`${PREFIX}/3.html`);
          return crawler.onIdle()
            .then(() => {
              assert.equal(crawler.isPaused(), true);
              assert.equal(onSuccess.callCount, 2);
              return crawler.queueSize();
            })
            .then(size => {
              assert.equal(size, 1);
              crawler.setMaxRequest(4);
              crawler.resume();
              return crawler.onIdle();
            })
            .then(() => {
              assert.equal(crawler.isPaused(), false);
              assert.equal(onSuccess.callCount, 3);
              return crawler.queueSize();
            })
            .then(size => {
              assert.equal(size, 0);
            });
        });
      });

      context('when the crawler is launched with preRequest option', () => {
        context('when preRequest returns true', () => {
          function preRequest() {
            return true;
          }

          beforeEach(() => (
            HCCrawler.launch(extend({ onSuccess, preRequest }, DEFAULT_OPTIONS))
              .then(_crawler => {
                crawler = _crawler;
              })
          ));

          afterEach(() => crawler.close());

          it('does not skip crawling', () => {
            let requestskipped = 0;
            crawler.on('requestskipped', () => { requestskipped += 1; });
            crawler.queue(INDEX_PAGE);
            return crawler.onIdle()
              .then(() => {
                assert.equal(requestskipped, 0);
                assert.equal(onSuccess.callCount, 1);
              });
          });
        });

        context('when preRequest returns false', () => {
          function preRequest() {
            return false;
          }

          beforeEach(() => (
            HCCrawler.launch(extend({ onSuccess, preRequest }, DEFAULT_OPTIONS))
              .then(_crawler => {
                crawler = _crawler;
              })
          ));

          afterEach(() => crawler.close());

          it('skips crawling', () => {
            let requestskipped = 0;
            crawler.on('requestskipped', () => { requestskipped += 1; });
            crawler.queue(INDEX_PAGE);
            return crawler.onIdle()
              .then(() => {
                assert.equal(requestskipped, 1);
                assert.equal(onSuccess.callCount, 0);
              });
          });
        });

        context('when preRequest modifies options', () => {
          const path = './tmp/example.png';
          function preRequest(options) {
            options.screenshot = { path };
            return true;
          }

          beforeEach(() => (
            HCCrawler.launch(extend({ onSuccess, preRequest }, DEFAULT_OPTIONS))
              .then(_crawler => {
                crawler = _crawler;
              })
          ));

          afterEach(() => crawler.close());

          it('modifies options', () => {
            crawler.queue(INDEX_PAGE);
            return crawler.onIdle()
              .then(() => {
                assert.equal(onSuccess.callCount, 1);
                assert.equal(onSuccess.firstCall.args[0].options.screenshot.path, path);
              });
          });
        });
      });

      context('when the crawler is launched with exporter option', () => {
        function removeTemporaryFile(file) {
          return new Promise(resolve => {
            unlink(file, (() => void resolve()));
          });
        }

        function readTemporaryFile(file) {
          return new Promise((resolve, reject) => {
            readFile(file, ENCODING, ((error, result) => {
              if (error) return reject(error);
              return resolve(result);
            }));
          });
        }

        afterEach(() => (
          crawler.close()
            .then(() => removeTemporaryFile(CSV_FILE))
        ));

        context('when the crawler is launched with exporter = CSVExporter', () => {
          beforeEach(() => (
            removeTemporaryFile(CSV_FILE)
              .then(() => {
                const exporter = new CSVExporter({
                  file: CSV_FILE,
                  fields: ['result'],
                });
                return HCCrawler.launch(extend({
                  evaluatePage,
                  onSuccess,
                  exporter,
                  maxConcurrency: 1,
                }, DEFAULT_OPTIONS))
                  .then(_crawler => {
                    crawler = _crawler;
                  });
              })
          ));

          it('exports a CSV file', () => {
            crawler.queue(`${PREFIX}/1.html`);
            crawler.queue(`${PREFIX}/2.html`);
            return crawler.onIdle()
              .then(() => readTemporaryFile(CSV_FILE))
              .then(actual => {
                const header = 'result\n';
                const line1 = '/1.html\n';
                const line2 = '/2.html\n';
                const expected = header + line1 + line2;
                assert.equal(actual, expected);
                assert.equal(onSuccess.callCount, 2);
              });
          });
        });

        context('when the crawler is launched with exporter = JSONLineExporter', () => {
          beforeEach(() => (
            removeTemporaryFile(JSON_FILE)
              .then(() => {
                const exporter = new JSONLineExporter({
                  file: JSON_FILE,
                  fields: ['result'],
                });
                return HCCrawler.launch(extend({
                  evaluatePage,
                  onSuccess,
                  exporter,
                  maxConcurrency: 1,
                }, DEFAULT_OPTIONS))
                  .then(_crawler => {
                    crawler = _crawler;
                  });
              })
          ));

          it('exports a json-line file', () => {
            crawler.queue(`${PREFIX}/1.html`);
            crawler.queue(`${PREFIX}/2.html`);
            return crawler.onIdle()
              .then(() => readTemporaryFile(JSON_FILE))
              .then(actual => {
                const line1 = `${JSON.stringify({ result: '/1.html' })}\n`;
                const line2 = `${JSON.stringify({ result: '/2.html' })}\n`;
                const expected = line1 + line2;
                assert.equal(actual, expected);
                assert.equal(onSuccess.callCount, 2);
              });
          });
        });
      });

      context('when the crawler is launched with redis cache', () => {
        context('for the fist time with persistCache = true', () => {
          beforeEach(() => {
            const cache = new RedisCache();
            return HCCrawler.launch(extend({
              onSuccess,
              cache,
              persistCache: true,
            }, DEFAULT_OPTIONS))
              .then(_crawler => {
                crawler = _crawler;
                return crawler.clearCache();
              });
          });

          afterEach(() => crawler.close());

          it('crawls all queued urls', () => {
            crawler.queue(`${PREFIX}/1.html`);
            crawler.queue(`${PREFIX}/2.html`);
            return crawler.onIdle()
              .then(() => {
                assert.equal(onSuccess.callCount, 2);
              });
          });
        });

        context('for the second time', () => {
          beforeEach(() => {
            const cache = new RedisCache();
            return HCCrawler.launch(extend({ onSuccess, cache }, DEFAULT_OPTIONS))
              .then(_crawler => {
                crawler = _crawler;
              });
          });

          afterEach(() => crawler.close());

          it('does not crawl already cached url', () => {
            crawler.queue(`${PREFIX}/2.html`);
            crawler.queue(`${PREFIX}/3.html`);
            return crawler.onIdle()
              .then(() => {
                assert.equal(onSuccess.callCount, 1);
              });
          });
        });
      });

      it('emits disconnect event', () => {
        let disconnected = 0;
        return HCCrawler.launch(DEFAULT_OPTIONS)
          .then(_crawler => {
            crawler = _crawler;
          })
          .then(() => void crawler.on('disconnected', () => { disconnected += 1; }))
          .then(() => crawler.close())
          .then(() => void assert.equal(disconnected, 1));
      });
    });

    context('when crawling fails', () => {
      const onError = sinon.spy();

      beforeEach(() => (
        HCCrawler.launch(extend({ onError }, DEFAULT_OPTIONS))
          .then(_crawler => {
            crawler = _crawler;
          })
      ));

      afterEach(() => crawler.close());

      it('retries and gives up', () => {
        let requestretried = 0;
        let requestfailed = 0;
        crawler.on('requestretried', () => { requestretried += 1; });
        crawler.on('requestfailed', () => { requestfailed += 1; });
        crawler.queue({ url: INDEX_PAGE, retryCount: 3, retryDelay: 100 });
        return crawler.onIdle()
          .then(() => {
            assert.equal(requestretried, 3);
            assert.equal(requestfailed, 1);
            assert.equal(crawler.pendingQueueSize(), 0);
            assert.equal(crawler.requestedCount(), 1);
            assert.equal(onError.callCount, 1);
          });
      });
    });
  });
});
