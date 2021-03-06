// builtin
var path = require('path');
var fs = require('fs');

// vendor
var mime = require('mime');
var uglifyjs = require('uglify-js');
var browserify = require('browserify');
var through = require('through');

module.exports = function enchilada(opt) {

    // if just a path is passed in, treat as public file dir
    if (typeof opt === 'string') {
        opt = { src: opt };
    }

    var pubdir = opt.src;
    var routes = opt.routes || {};
    var bundles = {};

    var compress = false || opt.compress;
    var cache = {};
    var debug = false || opt.debug;

    var watch = !opt.cache;
    var watchCallback = opt.watchCallback;

    function addTransforms(bundle) {
        if (opt.transforms) {
            opt.transforms.forEach(bundle.transform.bind(bundle));
        }
    }

    // list of files or modules which exist in other bundles
    var externals = [];

    // TODO(shtylman) externs that use other externs?
    var externs = Object.keys(routes).map(function(id) {
        var name = routes[id];

        var opt = {
            // don't bundle require code with externs
            client: false
        };

        var bundle = browserify();
        addTransforms(bundle);
        bundle.expose_all = true;
        bundle.require(name, { expose: true, basedir: pubdir });
        externals.push(name);
        return bundles[id] = bundle;
    });

    return function(req, res, next) {
        var req_path = req.path;

        // if no extension, then don't process
        // handles case of directories and other random urls
        if (!path.extname(req_path)) {
            return next();
        }
        else if (mime.lookup(req_path) !== 'application/javascript') {
            return next();
        }

        // check cache
        var cached = cache[req_path];
        if (cached) {
            return sendResponse(null, cached);
        }

        // check for bundle
        var bundle = bundles[req_path];
        if (bundle) {
            return generate(bundle, sendResponse);
        }

        var local_file = path.normalize(path.join(pubdir, req_path));

        // check for malicious attempts to access outside of pubdir
        if (local_file.indexOf(pubdir) !== 0) {
            return next();
        }

        // lookup in filesystem
        fs.exists(local_file, function(exists) {
            if (!exists) {
                return next();
            }

            var bundle = browserify(local_file);
            addTransforms(bundle);

            for (var id in bundles) {
                bundle.require(bundles[id]);
            }
            generate(bundle, sendResponse);
        });

        function generate(bundle, callback) {
            var dependencies = [];
            var originalDeps = bundle.deps;
            if (watch) {
                // Proxy bundle.deps() so that we can get the full list of dependencies used by bundle.bundle()
                bundle.deps = function(opts) {
                    var stream = originalDeps.call(this, opts);
                    stream.on('data', function(dependency) {
                        dependencies.push(dependency.id);
                    });
                    return stream;
                };
            }
            bundle.bundle({ debug: debug }, function(err, src) {
                if (watch) {
                    bundle.deps = originalDeps;
                }
                if (err) {
                    return callback(err);
                }

                if (compress) {
                    var result = uglifyjs.minify(src, {
                        fromString: true
                    });

                    src = result.code;
                }

                cache[req_path] = src;
                if (watch) {
                    watchFiles(bundle, dependencies, req_path);
                }

                callback(null, src);
            });
        }

        function sendResponse(err, src) {
            if (err) {
                return next(err);
            }
            res.contentType('application/javascript');
            res.send(src);
        }

        function watchFiles(bundle, dependencies, path) {
            var watchers = dependencies.map(function(filename) {
                return fs.watch(filename, { persistent:false }, function() {
                    delete cache[path];
                    generate(bundle, function(error) {
                        watchCallback && watchCallback(error, path);
                    });
                    watchers.forEach(function(watcher) {
                        watcher.close();
                    });
                });
            });
        }
    };
};

