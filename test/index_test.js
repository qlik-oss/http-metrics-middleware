const MetricsMiddleware = require('../index');
const os = require('os');
const promClient = require('prom-client');

const should = chai.should();

describe('MetricsMiddleware', () => {
  let metrics;
  let metricsMock;
  let metricsPromClient;

  beforeEach(() => {
    metricsPromClient = sinon.mock(MetricsMiddleware.promClient);
    metrics = new MetricsMiddleware();
    metricsMock = sinon.mock(metrics);
  });

  afterEach(() => {
    metricsMock.restore();
    MetricsMiddleware.promClient.register.clear();
    metricsPromClient.restore();
  });

  describe('constructor', () => {
    it('defaults correctly', () => {
      metrics = new MetricsMiddleware();
      Object.keys(MetricsMiddleware.defaultOpts).forEach((key) => {
        metrics.options.should.have.property(key);
      });
    });
    it('overrides correctly', () => {
      metrics = new MetricsMiddleware({
        includeError: true,
        includePath: false,
      });
      Object.keys(MetricsMiddleware.defaultOpts).forEach((key) => {
        metrics.options.should.have.property(key);
      });
    });
  });

  describe('normalizePath', () => {
    it('does nothing given an already-normalized path', () => {
      const originalUrl = '/api/v1/foo';
      metrics.normalizePath({ originalUrl }).should.eql(originalUrl);
    });

    it('replaces numeric id on request with no params', () => {
      const originalUrl = '/api/v1/foo/1234567';
      const expected = '/api/v1/foo/#val';
      metrics.normalizePath({ originalUrl }).should.eql(expected);
    });

    it('replaces params on request with params', () => {
      const id = 'blahblahblah';
      const name = 'fred';
      const originalUrl = `/api/v1/foo/${id}/${name}`;
      const expected = '/api/v1/foo/#id/#name';
      metrics.normalizePath({ originalUrl, params: { id, name } }).should.eql(expected);
    });

    it('replaces params on request with encoded params', () => {
      const sessionId = 's:5nD_Q3OZw6Rdxwo1pMH7vdyxLjESwE6M.WEO/Qg6w4byzreqv4IFcwVU/PmGHfGMAKt9Ke7nOhho';
      const originalUrl = `/ext-sess/session/${encodeURIComponent(sessionId)}?xrfkey=blahblah`;
      const expected = '/ext-sess/session/#sessionId';
      metrics.normalizePath({ originalUrl, params: { sessionId } }).should.eql(expected);
    });

    it('replaces params on request with params that have unencoded slashes in them', () => {
      const id = 'cafedeadbeef/foo';
      const resource = 'users';
      const originalUrl = `/api/v1/${resource}/${id}`;
      const expected = '/api/v1/#resource/#0';
      metrics.normalizePath({ originalUrl, params: { resource, 0: id } }).should.eql(expected);
    });

    it('replaces params on request with params that have mixture of encoded and unencoded characters', () => {
      const foo = 'foo';
      const mixed = 'bar/baz[$qux]%3dquux%26quuz*]]%3dcorge%2e%2a';
      const originalUrl = `/${foo}/${mixed}`;
      const expected = '/#foo/#0';
      metrics.normalizePath({ originalUrl, params: { foo, 0: mixed } }).should.eql(expected);
    });

    it('does not replace sub-resources', () => {
      const id = 'blahblahblah';
      const originalUrl = `/api/v1/foo/${id}/data`;
      const expected = '/api/v1/foo/#id/data';
      metrics.normalizePath({ originalUrl, params: { id } }).should.eql(expected);
    });

    it('does not replace ignored params', () => {
      const id = 'blahblahblah';
      const resource = 'foobar';
      const originalUrl = `/api/v1/foo/${id}/${resource}`;
      const expected = '/api/v1/foo/#id/foobar';
      metrics.options.paramIgnores = ['resource'];
      metrics.normalizePath({ originalUrl, params: { id, resource } }).should.eql(expected);
    });
  });

  describe('initBuildInfo', () => {
    it('requires nameserver', () => {
      should.throw(() => {
        metrics.initBuildInfo('', '', '', '');
      });
    });

    it('sets labels and value correctly', () => {
      const ns = 'foo';
      const version = '1.2.3';
      const revision = 'abcd1234';
      const buildTime = '2017-07-07T07:07:07.007Z';
      const m = metrics.initBuildInfo(ns, version, revision, buildTime);
      m.name.should.eql('foo_build_info');
      m.hashMap[Object.keys(m.hashMap)[0]].labels.should.eql({
        version,
        revision,
        buildTime,
        nodeVersion: process.version,
        os: process.platform,
        platform: 'node',
        osRelease: os.release(),
      });
      m.hashMap[Object.keys(m.hashMap)[0]].value.should.eql(1);
    });
  });

  describe('normalizeStatusCode', () => {
    it('returns status_code by default', () => {
      const res = {
        status_code: 200,
        statusCode: 'nope',
      };
      metrics.normalizeStatusCode(res).should.eql(200);
    });

    it('returns statusCode otherwise', () => {
      const res = { statusCode: 200 };
      metrics.normalizeStatusCode(res).should.eql(200);
    });
  });

  describe('observeDurations', () => {
    it('does not crash given no durationMetrics', () => {
      metrics.observeDurations({}, 0);
    });

    it('sets durations for each defined metric', () => {
      const fakeMetric = {
        observedLabels: [],
        observedDurations: [],
        observe(labelValues, duration) {
          this.observedLabels.push(labelValues);
          this.observedDurations.push(duration);
        },
      };
      metrics.durationMetrics = [
        fakeMetric,
        fakeMetric,
      ];
      const label = { foo: 'foo' };
      metrics.observeDurations(label, 42);
      fakeMetric.observedDurations.should.eql([42, 42]);
      fakeMetric.observedLabels.should.eql([label, label]);
    });
  });

  describe('trackDuration', () => {
    it('skips excluded routes', (done) => {
      metrics.options.excludeRoutes = ['/foo'];
      metrics.trackDuration({ originalUrl: '/foo' }, null, done);
    });

    it('observes after response sent', (done) => {
      const res = {
        finished: true,
        status_code: 200,
        req: {
          route: {
            path: '/bar',
          },
        },
      };
      metricsMock.expects('observeDurations').withArgs({ status_code: 200, method: 'GET', path: '/bar' }, sinon.match.number).returns(true);
      metrics.options.excludeRoutes = ['/foo'];
      metrics.trackDuration({ method: 'GET', originalUrl: '/bar' }, res, () => {
        setImmediate(() => {
          metricsMock.verify();
          done();
        });
      });
    });

    it('includes path if enabled', (done) => {
      const res = {
        finished: true,
        status_code: 200,
        req: {
          route: {
            path: '/bar',
          },
        },
      };
      metricsMock.expects('observeDurations').withArgs({ status_code: 200, method: 'GET', path: '/bar' }, sinon.match.number).returns(true);
      metrics.options.excludeRoutes = ['/foo'];
      metrics.options.includePath = true;
      metrics.trackDuration({ method: 'GET', originalUrl: '/bar' }, res, () => {
        setImmediate(() => {
          metricsMock.verify();
          done();
        });
      });
    });

    it('excludes path if disabled', (done) => {
      const res = {
        finished: true,
        status_code: 200,
        req: {
          route: {
            path: '/bar',
          },
        },
      };
      metricsMock.expects('observeDurations').withArgs({ status_code: 200, method: 'GET' }, sinon.match.number).returns(true);
      metrics.options.excludeRoutes = ['/foo'];
      metrics.options.includePath = false;
      metrics.trackDuration({ method: 'GET', originalUrl: '/bar' }, res, () => {
        setImmediate(() => {
          metricsMock.verify();
          done();
        });
      });
    });

    it('excludes path on fall-through', (done) => {
      const res = {
        finished: true,
        status_code: 404,
        req: {},
      };
      metricsMock.expects('observeDurations').withArgs({ status_code: 404, method: 'GET' }, sinon.match.number).returns(true);
      metrics.options.excludeRoutes = ['/foo'];
      metrics.options.includePath = true;
      metrics.trackDuration({ method: 'GET', originalUrl: '/bar' }, res, () => {
        setImmediate(() => {
          metricsMock.verify();
          done();
        });
      });
    });
  });

  describe('matchVsRegExps', () => {
    it('non-matching cases', () => {
      metrics.matchVsRegExps().should.equal(false);
      metrics.matchVsRegExps('foo').should.equal(false);
      metrics.matchVsRegExps('foo', []).should.equal(false);
      metrics.matchVsRegExps('foo', ['bar']).should.equal(false);
      metrics.matchVsRegExps('foo', ['bar', /^[A-Z]*$/]).should.equal(false);
    });

    it('matching cases', () => {
      metrics.matchVsRegExps('foo', ['foo']).should.equal(true);
      metrics.matchVsRegExps('foo', ['bar', 'baz', 'foo']).should.equal(true);
      metrics.matchVsRegExps('foo', ['bar', 'baz', /f.*o$/]).should.equal(true);
    });
  });

  describe('initRoutes', () => {
    it('does not enable duration summary or histogram when neither are requested', () => {
      metrics = new MetricsMiddleware({
        enableDurationSummary: false,
        enableDurationHistogram: false,
      });

      metrics.initRoutes();

      metrics.durationMetrics.should.be.empty;
    });

    it('enables duration summary when requested', () => {
      metrics.options.enableDurationSummary = true;
      metrics.options.enableDurationHistogram = false;

      metrics.initRoutes();

      metrics.durationMetrics.should.have.length(1);
      metrics.durationMetrics.forEach((m) => {
        m.should.have.instanceof(promClient.Summary);
      });
    });

    it('enables duration histogram when requested', () => {
      metrics.options.enableDurationSummary = false;
      metrics.options.enableDurationHistogram = true;

      metrics.initRoutes();

      metrics.durationMetrics.should.have.length(1);
      metrics.durationMetrics.forEach((m) => {
        m.should.have.instanceof(promClient.Histogram);
      });
    });

    it('starts collection of default metrics', () => {
      metricsPromClient.expects('collectDefaultMetrics').once();
      metrics.initRoutes();

      metricsPromClient.verify();
    });
  });

  describe('metricsRoute', () => {
    let res;
    let resMock;
    let registerMock;

    beforeEach(() => {
      res = {
        writeHead() { throw new Error('unexpected writeHead() called'); },
        end() { throw new Error('unexpected end() called'); },
        setHeader() { throw new Error('unexpected setHeader() called'); },
      };
      resMock = sinon.mock(res);
      registerMock = sinon.mock(promClient.register);
    });

    afterEach(() => {
      resMock.restore();
      registerMock.restore();
    });

    it('404s when proxied', () => {
      resMock.expects('writeHead').withArgs(404);
      resMock.expects('end');
      metrics.metricsRoute({ headers: { 'x-forwarded-for': 'foo' } }, res);
      resMock.verify();
    });

    it('registers metrics', () => {
      resMock.expects('setHeader').withArgs('Content-Type', 'text/plain');
      registerMock.expects('metrics').returns('foo');
      resMock.expects('end').withArgs('foo');

      metrics.metricsRoute({ headers: { accept: 'text/plain' } }, res);
      resMock.verify();
      metricsPromClient.verify();
      registerMock.verify();
    });
  });
});
