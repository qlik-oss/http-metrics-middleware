[![Build Status][circleci-image]][circleci-url]
[![Code Climate GPA][codeclimate-gpa-image]][codeclimate-url]
[![Test Coverage][codeclimate-coverage-image]][codeclimate-coverage-url]
[![Issue Count][codeclimate-issues-image]][codeclimate-url]

# http-metrics-middleware

[![Greenkeeper badge](https://badges.greenkeeper.io/qlik-oss/http-metrics-middleware.svg?token=FIXME&ts=FIXME)](https://greenkeeper.io/)

Express middleware with useful prometheus metrics.

This wraps [prom-client][], and adds some default metrics.

## Contributing

Contributions are welcome and encouraged! Please follow the instructions in [CONTRIBUTING.md](.github/CONTRIBUTING.md).

## Usage

Simplest usage is:

```js
const MetricsMiddleware = require('http-metrics-middleware')
const express = require('express')

var metrics = new MetricsMiddleware()
app.use(metrics.initRoutes())
```

With `koa` using `koa-connect`:

```js
const MetricsMiddleware = require('http-metrics-middleware')
const c2k = require('koa-connect')

var metrics = new MetricsMiddleware()
app.use(c2k(metrics.initRoutes()))
```

### Options

The middleware can be configured by providing an `options` object to the
constructor.

| option | default | info |
|--------|---------|------|
| `timeBuckets` | `[ 0.01, 0.1, 0.5, 1, 5 ]` |  the buckets to assign to duration histogram (in seconds) |
| `quantileBuckets` | `[ 0.1, 0.5, 0.95, 0.99 ]` |  the quantiles to assign to duration summary (0.0 - 1.0) |
| `includeError` | `false` | whether or not to include presence of an unhandled error as a label |
| `includePath` | `true` |  whether or not to include normalized URL path as a metric label - see [about `includePath`](#about-includepath) below |
| `normalizePath` | |  a `function(req)` - generates path values from the express `req` object |
| `paramIgnores` | `[]` |  array of path parameters _not_ to replace. _Use with caution as this may cause high label cardinality._ |
| `formatStatusCode` | `(res) => res.status_code || res.statusCode` |  a `function(res)` - generates path values from the express `res` object |
| `enableDurationHistogram` | `true` |  whether to enable the request duration histogram |
| `enableDurationSummary` | `true` |  whether to enable the request duration summary |
| `durationHistogramName` | `http_request_duration_seconds` |  the name of the duration histogram metric - must be unique |
| `durationSummaryName` | `http_request_duration_quantile_seconds` |  the name of duration summary metric - must be unique |

#### about `includePath`

While it can be useful to know which endpoints are being exercised, including
the `path` label can cause an explosion in tracked metrics from your service
when the malicious or poorly-configured clients send strange URLs.

For this reason, it is recommended that you set `includePath` to `false`, unless
your route parameters are restricted to include only desired values.

Paths are never included on requests which were not handled by a route
with an explicit path (i.e. `app.use` where the first argument is a callback).

For example:

```js
// here, the path label will be tracked if `includePath` is enabled
// BUT don't do this - restrict the param with a regex like the next example
app.get('/api/v1/:resource/*', (req, res) => {
  res.send('foo')
})

// this is better, as the resource param only matches a certain pattern
app.get('/api/v1/:resource([a-z]+)/*', (req, res) => {
  res.send('foo')
})

// here, the path label will never be tracked 
app.use((req, res) => {
  res.send('foo')
})
```

### Defining custom metrics

The underlying [`prom-client`][prom-client] module is available for specifying your own custom metrics:

```js
const promClient = require('http-metrics-middleware').promClient

var myHistogram = new promClient.Histogram({
  name: 'foo_duration_seconds',
  help: 'track the duration of foo',
  labelNames: [ 'bar', 'baz' ],
  buckets: [1, 2, 3, 4, 5]
})
```

## Metrics

In additional to the [default metrics](https://github.com/siimon/prom-client/blob/master/lib/defaultMetrics.js)
provided by [prom-client][], this module adds:

- `http_request_duration_seconds` - _(optional, enabled by default)_ http latency histogram labeled with `status_code`, `method`, `path`, and `error` _(disabled by default - enable with `includeError` option)_
  - use the `enableDurationHistogram` boolean property to control whether or not this is enabled
  - use the `durationHistogramName` property to give this metric a different name (required if you want both the histogram and summary)
- `http_request_duration_seconds` - _(optional, disabled by default)_ http latency summary labeled with `status_code`, `method`, `path`, and `error` _(disabled by default - enable with `includeError` option)_
  - use the `enableDurationSummary` boolean property to control whether or not this is enabled
  - use the `durationSummaryName` property to give this metric a different name (required if you want both the histogram and summary)
- `*_build_info` - build information about the service (initialized with `initBuildInfo` function)
  ```js
  const MetricsMiddleware = require('http-metrics-middleware')
  var metrics = new MetricsMiddleware()

  var ns = 'myservice'
  var version = '1.2.3'
  var revision = 'abcd1234'
  var buildTime = '2017-07-07T07:07:07.007Z'
  metrics.initBuildInfo(ns, version, revision, buildTime)
  ```

### Sample output

```text
http_request_duration_seconds_bucket{le="0.05",status_code="200",path="/",method="GET"} 5
http_request_duration_seconds_bucket{le="0.1",status_code="200",path="/",method="GET"} 7
http_request_duration_seconds_bucket{le="0.5",status_code="200",path="/",method="GET"} 10
http_request_duration_seconds_bucket{le="1",status_code="200",path="/",method="GET"} 13
http_request_duration_seconds_bucket{le="+Inf",status_code="200",path="/",method="GET"} 15
http_request_duration_seconds_count{status_code="200",path="/",method="GET"} 15
http_request_duration_seconds_sum{status_code="200",path="/",method="GET"} 18.534
```

[circleci-image]: https://circleci.com/gh/qlik-oss/http-metrics-middleware.svg?style=shield&circle-token=d1a68a4809e9cd7056a9d537b802955fef0025d4
[circleci-url]: https://circleci.com/gh/qlik-oss/http-metrics-middleware

[prom-client]: https://github.com/siimon/prom-client

[codeclimate-url]: https://codeclimate.com/repos/FIXME/feed

[codeclimate-gpa-image]: https://codeclimate.com/repos/FIXME/badges/FIXME/gpa.svg
[codeclimate-coverage-image]: https://codeclimate.com/repos/FIXME/badges/FIXME/coverage.svg
[codeclimate-coverage-url]: https://codeclimate.com/repos/FIXME/coverage
[codeclimate-issues-image]: https://codeclimate.com/repos/FIXME/badges/FIXME/issue_count.svg
