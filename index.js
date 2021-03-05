const express = require('express');
const promClient = require('prom-client');
const UrlValueParser = require('url-value-parser');
const url = require('url');
const os = require('os');
const onFinished = require('on-finished');
const now = require('performance-now');
const _ = require('lodash');

const defaultOpts = {
  metricsPath: '/metrics',
  enableDurationHistogram: true,
  enableDurationSummary: true,
  timeBuckets: [0.01, 0.1, 0.5, 1, 5],
  quantileBuckets: [0.1, 0.5, 0.95, 0.99],
  includeError: false,
  includePath: true,
  paramIgnores: [],
  durationHistogramName: 'http_request_duration_seconds',
  durationSummaryName: 'http_request_duration_quantile_seconds',
};

/** Express middleware to add prometheus integration */
class MetricsMiddleware {
  /**
   * @typedef MetricsOptions
   * @type {object}
   * @property {string} metricsPath - defines custom metrics path
   * @property {number[]} timeBuckets - the buckets to assign to duration histogram (in seconds)
   * @property {number[]} quantileBuckets - the quantiles to assign to duration summary (0.0 - 1.0)
   * @property {number} quantileMaxAge configures sliding time window for summary (in seconds)
   * @property {number} quantileAgeBuckets configures number of sliding time window buckets for summary
   * @property {string[]} paramIgnores - array of params _not_ to replace
   * @property {boolean} includeError - whether or not to include presence of an unhandled error as a label - defaults to false
   * @property {boolean} includePath - whether or not to include the URL path as a metric label - defaults to true
   * @property {Function} normalizePath - a `function(req)` - generates path values from the express `req` object
   * @property {Function} formatStatusCode - a `function(req)` - generates path values from the express `req` object
   * @property {boolean} enableDurationHistogram - whether to enable the request duration histogram (default: true)
   * @property {boolean} enableDurationSummary - whether to enable the request duration summary (default: true)
   * @property {string} durationHistogramName - the name of the duration histogram metric (if enabled) - must be unique
   * @property {string} durationSummaryName - the name of duration summary metric (if enabled) - must be unique
   */

  /**
   * Create a MetricsMiddleware
   *
   * @param {MetricsOptions} options - the options
   */
  constructor(options = {}) {
    _.defaults(options, defaultOpts, {
      normalizePath: this.normalizePath.bind(this),
      formatStatusCode: this.normalizeStatusCode.bind(this),
      quantileMaxAge: 600,
      quantileAgeBuckets: 5,
    });
    this.options = options;
    this.router = express.Router();
    this.urlValueParser = this.options.urlValueParser || new UrlValueParser();
    this.durationMetrics = [];
  }

  /**
   * Initialize the build_info metric
   *
   * @param {string} ns - the namespace for the metric - usually the name of the service
   * @param {string} version - the service's version
   * @param {string} revision - the git SHA hash for the running code (usually short-SHA)
   */
  initBuildInfo(ns, version, revision) {
    if (!ns) {
      throw new Error('namespace (ns) must be provided for build_info metric!');
    }
    const buildInfo = new promClient.Gauge({
      name: `${ns}_build_info`,
      help: `A metric with a constant 1 value labeled by version, revision, platform, nodeVersion, os from which ${ns} was built`,
      labelNames: ['version', 'revision', 'platform', 'nodeVersion', 'os', 'osRelease'],
    });
    buildInfo.set(
      {
        version,
        revision,
        platform: process.release.name,
        nodeVersion: process.version,
        os: process.platform,
        osRelease: os.release(),
      },
      1,
    );
    return buildInfo;
  }

  initRoutes() {
    const labelNames = ['status_code', 'method'];
    if (this.options.includePath) {
      labelNames.push('path');
    }
    if (this.options.enableDurationSummary) {
      this.durationMetrics.push(new promClient.Summary({
        name: this.options.durationSummaryName,
        help: `duration summary of http responses labeled with: ${labelNames.join(', ')}`,
        labelNames,
        percentiles: this.options.quantileBuckets,
        maxAgeSeconds: this.options.quantileMaxAge,
        ageBuckets: this.options.quantileAgeBuckets,
      }));
    }
    if (this.options.enableDurationHistogram) {
      this.durationMetrics.push(new promClient.Histogram({
        name: this.options.durationHistogramName,
        help: `duration histogram of http responses labeled with: ${labelNames.join(', ')}`,
        labelNames,
        buckets: this.options.timeBuckets,
      }));
    }
    promClient.collectDefaultMetrics();

    this.router.get(this.options.metricsPath, this.metricsRoute.bind(this));
    this.router.use(this.trackDuration.bind(this));
    return this.router;
  }

  async metricsRoute(req, res) {
    if (req.headers['x-forwarded-for']) {
      res.writeHead(404);
      return res.end('Not Found');
    }

    res.statusCode = 200;
    return res.end(await promClient.register.metrics());
  }

  trackDuration(req, res, next) {
    if (
      this.options.excludeRoutes
      && this.matchVsRegExps(req.originalUrl, this.options.excludeRoutes)
    ) {
      return next();
    }

    const start = now();
    onFinished(res, (err, resp) => {
      const end = now();

      const labels = {
        status_code: this.options.formatStatusCode(resp, this.options),
        method: req.method,
      };
      // if we're on a route that has been mounted, resp.req.route.path will be set
      if (
        this.options.includePath
        && resp.req
        && resp.req.route
        && resp.req.route.path
      ) {
        labels.path = this.options.normalizePath(req, this.options);
      }
      if (this.options.includeError && !!err) {
        labels.error = 'true';
      }

      const duration = (parseFloat(end.toFixed(9)) - parseFloat(start.toFixed(9))) / 1000;
      this.observeDurations(labels, duration);
    });
    return next();
  }

  observeDurations(labelValues, duration) {
    this.durationMetrics.forEach((metric) => {
      metric.observe(labelValues, duration);
    });
  }

  normalizeStatusCode(res) {
    return res.status_code || res.statusCode;
  }

  normalizePath(req) {
    let path = url.parse(req.originalUrl).pathname;
    path = this.replaceParams(path, req.params);
    return this.urlValueParser.replacePathValues(path);
  }

  replaceParams(path, params) {
    let pathValue = path;
    if (params) {
      Object.keys(params).forEach((param) => {
        if (
          Object.prototype.hasOwnProperty.call(params, param)
          && !this.options.paramIgnores.includes(param)
        ) {
          pathValue = this.replaceParam(params, param, pathValue);
        }
      });
    }
    return pathValue;
  }

  replaceParam(params, param, path) {
    let encoded = encodeURI(params[param]);
    if (path.includes(encoded)) {
      return path.replace(encoded, `#${param}`);
    }

    encoded = encodeURIComponent(params[param]);
    if (path.includes(encoded)) {
      return path.replace(encoded, `#${param}`);
    }

    if (path.includes(params[param])) {
      return encodeURI(path.replace(params[param], `#${param}`));
    }

    return path;
  }

  matchVsRegExps(element, regexps) {
    if (!element || !regexps) {
      return false;
    }

    return regexps.some((regexp) => (regexp instanceof RegExp && element.match(regexp))
      || element === regexp);
  }
}

// export prom-client for use in custom metrics
MetricsMiddleware.promClient = promClient;
MetricsMiddleware.defaultOpts = defaultOpts;
module.exports = MetricsMiddleware;
