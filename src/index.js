import readPkgUp from 'read-pkg-up';
import ExternalModule from 'webpack/lib/ExternalModule';
import resolvePkg from 'resolve-pkg';
import {RawSource} from 'webpack-sources';
import fs from 'fs';

import getResolver from './get-resolver';

const pluginName = 'dynamic-cdn-webpack-plugin';
let HtmlWebpackPlugin;
try {
    HtmlWebpackPlugin = require('html-webpack-plugin');
} catch {
    HtmlWebpackPlugin = null;
}

const moduleRegex = /^((?:@[a-z\d][\w-.]+\/)?[a-z\d][\w-.]*)/;

const getEnvironment = mode => {
    switch (mode) {
        case 'none':
        case 'development':
            return 'development';

        default:
            return 'production';
    }
};

function getDeps(cdnConfig) {
    return Object.keys(cdnConfig).reduce((acc, key) => {
        acc[key] = {
            name: cdnConfig[key].name,
            var: cdnConfig[key].var,
            version: cdnConfig[key].version,
            path: cdnConfig[key].path,
            stylePath: cdnConfig[key].stylePath
        };
        return acc;
    }, {});
}

function getPackageRootPath(name) {
    let main;
    try {
        main = require.resolve(name);
    } catch {
        return;
    }

    const index = main.indexOf(name);
    return main.slice(0, index + name.length);
}

export default class DynamicCdnWebpackPlugin {
    constructor({disable = false, env, exclude, only, resolver, loglevel = 'ERROR', verbose} = {}) {
        if (exclude && only) {
            throw new Error("You can't use 'exclude' and 'only' at the same time");
        }

        this.disable = disable;
        this.env = env;
        this.exclude = exclude || [];
        this.only = only || null;
        this.resolver = getResolver(resolver);
        this.loglevel = verbose ? 'DEBUG' : loglevel;

        this.log = (...message) => {
            console.log('\nDynamicCdnWebpackPlugin:', ...message);
        };

        if (this.loglevel === 'ERROR') {
            this.log = () => {};
        }

        this.debug = () => {};
        if (this.loglevel === 'DEBUG') {
            this.debug = (...message) => {
                console.debug('\nDynamicCdnWebpackPlugin:', ...message);
            };
        }

        this.error = (...message) => {
            console.error('\nDynamicCdnWebpackPlugin ERROR:', ...message);
        };

        this.modulesFromCdn = {};
    }

    apply(compiler) {
        if (!this.disable) {
            this.execute(compiler, {
                env: this.env || getEnvironment(compiler.options.mode)
            });
        }

        const isUsingHtmlWebpackPlugin =
            HtmlWebpackPlugin != null &&
            compiler.options.plugins.some(x => x instanceof HtmlWebpackPlugin);

        if (isUsingHtmlWebpackPlugin) {
            this.applyHtmlWebpackPlugin(compiler);
        } else {
            this.applyWebpackCore(compiler);
        }
    }

    execute(compiler, {env}) {
        compiler.hooks.normalModuleFactory.tap(pluginName, nmf => {
            nmf.hooks.factory.tap(pluginName, factory => async (data, cb) => {
                const modulePath = data.dependencies[0].request;
                const contextPath = data.context;

                const isModulePath = moduleRegex.test(modulePath);
                if (!isModulePath) {
                    return factory(data, cb);
                }

                const varName = await this.addModule(contextPath, modulePath, {
                    env
                });

                if (varName === false) {
                    factory(data, cb);
                } else if (varName == null) {
                    cb(null, new ExternalModule('{}', 'var', modulePath));
                } else {
                    cb(null, new ExternalModule(varName, 'var', modulePath));
                }
            });
        });
    }

    async addModule(contextPath, modulePath, {env}) {
        const isModuleExcluded =
            this.exclude.includes(modulePath) || (this.only && !this.only.includes(modulePath));
        if (isModuleExcluded) {
            return false;
        }

        const moduleName = modulePath.match(moduleRegex)[1];
        const cwd = resolvePkg(moduleName, {cwd: contextPath});
        if (!cwd) {
            // The module is not installed
            return false;
        }

        const {
            packageJson: {version, peerDependencies, dependencies}
        } = readPkgUp.sync({cwd});

        const isModuleAlreadyLoaded = Boolean(this.modulesFromCdn[modulePath]);
        if (isModuleAlreadyLoaded) {
            const isSameVersion = this.modulesFromCdn[modulePath].version === version;
            if (isSameVersion) {
                return this.modulesFromCdn[modulePath].var;
            }

            this.log(
                '\n‼️',
                modulePath,
                version,
                'is already loaded in another version. you have this deps twice'
            );
            return false;
        }

        const cdnConfig = await this.resolver(modulePath, version, {env});

        if (cdnConfig == null) {
            this.debug(
                '\n❔',
                modulePath,
                version,
                "couldn't be found, if you want it you can add it to your resolver."
            );
            return false;
        }

        // Try to get the manifest
        const depPath = `${getPackageRootPath(cdnConfig.name)}${cdnConfig.path}.dependencies.json`;
        if (fs.existsSync(depPath)) {
            const manifest = require(depPath);
            for (const dependencyName of Object.keys(manifest)) {
                await this.addModule(contextPath, dependencyName, {
                    env
                });
            }
        } else {
            if (dependencies) {
                // We build our lib using module-to-cdn, don t care of the results
                for (const dependencyName of Object.keys(dependencies)) {
                    await this.addModule(contextPath, dependencyName, {
                        env
                    });
                }
            }

            if (peerDependencies) {
                const arePeerDependenciesLoaded = (
                    await Promise.all(
                        Object.keys(peerDependencies).map(peerDependencyName => {
                            const result = this.addModule(contextPath, peerDependencyName, {env});
                            result.then(found => {
                                if (!found) {
                                    this.error(
                                        '\n❌',
                                        modulePath,
                                        version,
                                        "couldn't be loaded because peer dependency is missing",
                                        peerDependencyName
                                    );
                                }
                            });

                            return result;
                        })
                    )
                )
                    .map(x => Boolean(x))
                    .reduce((result, x) => result && x, true);

                if (!arePeerDependenciesLoaded) {
                    return false;
                }
            }
        }

        this.modulesFromCdn[modulePath] = cdnConfig;
        this.debug('\n✅', modulePath, version, `will be served by ${cdnConfig.url}`);
        return cdnConfig.var;
    }

    applyWebpackCore(compiler) {
        compiler.hooks.afterCompile.tapAsync(pluginName, (compilation, cb) => {
            if (!compiler.options.output.filename.includes('[')) {
                const depName = `${compiler.options.output.filename}.dependencies.json`;
                compilation.assets[depName] = new RawSource(
                    JSON.stringify(getDeps(this.modulesFromCdn))
                );
            }

            for (const [name, cdnConfig] of Object.entries(this.modulesFromCdn)) {
                compilation.addChunkInGroup(name);
                const chunk = compilation.addChunk(name);
                chunk.files.push(cdnConfig.url);
            }

            cb();
        });
    }

    applyHtmlWebpackPlugin(compiler) {
        compiler.hooks.compilation.tap(pluginName, compilation => {
            // Static Plugin interface |compilation |HOOK NAME | register listener
            const alterAssets = (data, cb) => {
                const cdnAssets = Object.values(this.modulesFromCdn).map(
                    moduleFromCdn => moduleFromCdn.url
                );
                const cdnCssAssets = Object.values(this.modulesFromCdn)
                    .map(moduleFromCdn => moduleFromCdn.styleUrl)
                    .filter(Boolean);
                data.assets.js = [].concat(cdnAssets, data.assets.js);
                data.assets.css = [].concat(cdnCssAssets, data.assets.css);

                // Tell webpack to move on
                if (cb) {
                    cb(null, data);
                }

                return data;
            };

            if (HtmlWebpackPlugin.getHooks) {
                HtmlWebpackPlugin.getHooks(compilation).beforeAssetTagGeneration.tapAsync(
                    pluginName,
                    alterAssets
                );
            } else if (
                compilation.hooks &&
                compilation.hooks.htmlWebpackPluginBeforeHtmlGeneration
            ) {
                compilation.hooks.htmlWebpackPluginBeforeHtmlGeneration.tapAsync(
                    pluginName,
                    alterAssets
                );
            } else {
                throw new Error(
                    '@talend/dynamic-cdn-webpack-plugin support only webpack-html-plugin 3.2 and 4.x'
                );
            }
        });
    }
}
