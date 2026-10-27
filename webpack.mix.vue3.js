const mix = require("laravel-mix");
const path = require("path");
const glob = require("glob");
const postcssCssVariables = require("postcss-css-variables");

mix.setPublicPath("public_html/common/");

// Migration test: all Vue SFCs are compiled as Vue 3.
// TARGET_SCRIPT: all | c | mypage | agent | none
// SCRIPT_FILE: relative to work/src/common/js/ (overrides area selection when JS is enabled)
// STYLE: all | c | mypage | agent | none
const compileScriptFile = process.env.SCRIPT_FILE;
const compileScript = process.env.TARGET_SCRIPT || "all";
const compileCss = process.env.STYLE || "all";

/**
 * パスのエイリアスを設定
 * 深い階層にあっても、相対パス地獄にならないように。
 *
 * import hoge from '@c/hoge.js' -> work/src/common/js/c/hoge.js
 * のように解釈してくれる
 */
mix.webpackConfig({
  resolve: {
    extensions: [".js", ".vue", ".json"],
    alias: {
      // Force Vue 3 for every import of "vue", including imports inside Vuetify 4.
      vue$: require.resolve("vue/dist/vue.runtime.esm-bundler.js"),
      "@c": path.resolve(__dirname, "src/common/js/c"),
      "@mypage": path.resolve(__dirname, "src/common/js/mypage"),
      "@agent": path.resolve(__dirname, "src/common/js/agent"),
      "@": path.resolve(__dirname, "src/common/js"),
      "@resources": path.resolve(__dirname, "../resources"),
      "@components": path.resolve(__dirname, "src/common/js/components"),
      "@vuePlugins": path.resolve(__dirname, "src/common/js/vue/plugins"),
      "@vueMixins": path.resolve(__dirname, "src/common/js/vue/mixins"),

      "@resrc": path.resolve(__dirname, "src/common/js/resources"),

      "@css": path.resolve(__dirname, "src/common/css"),
    },
  },
  // No legacy Vuetify auto-import plugin.
  // Local components named VTextField, VSelect, VTextarea and VAutocomplete
  // must take priority over Vuetify's globally registered components.
  ignoreWarnings: [
    { module: /node_modules\/vuetify/ },
    { message: /sass-lang\.com\/d\// },
    { message: /Sass @import rules are deprecated/ },
    { message: /The Sass if\(\) syntax is deprecated/ },
    { module: /node_modules\/mdbvue/ },
  ],
});

// The old uglify option from the Vue 2 baseline is removed.
// Laravel Mix 6 / Webpack 5 handles production minimization separately.
mix.options({
  sassOptions: {
    indentedSyntax: true,
  },
});

// sass
// mix.sass('resources/assets/sass/app.sass', 'public/css')
//   .sass('resources/assets/sass/admin.sass', 'public/css/admin');

// postCss
// https://github.com/JeffreyWay/laravel-mix/issues/1564#issuecomment-375932044

// normal css
// mix.styles(['path/to/infile.css'], 'output_path/to/output.css');

// MDB
// 普段はコメントアウト。
// MDB更新やstyle.cssに追記したときなどにだけ有効にする
// mix.styles(
//   [
//     "work/src/common/mdb/css/bootstrap.css",
//     "work/src/common/mdb/css/mdb-pro.css",
//     "work/src/common/mdb/css/addons/datatables.min.css",
//     "work/src/common/mdb/css/addons/datatables2.min.css",
//     "work/src/common/mdb/css/addons/datatables-select.min.css",
//     "work/src/common/mdb/css/addons/datatables-select2.min.css",
//     "work/src/common/mdb/css/addons/directives.min.css",
//     "work/src/common/mdb/css/addons/flag.min.css",
//     "work/src/common/mdb/css/addons/jquery.zmd.hierarchical-display.min.css",
//     "work/src/common/mdb/css/addons/rating.min.css",
//     "work/src/common/mdb/css/addons-pro/cards-extended.min.css",
//     "work/src/common/mdb/css/addons-pro/chat.min.css",
//     "work/src/common/mdb/css/addons-pro/multi-range.min.css",
//     "work/src/common/mdb/css/addons-pro/simple-charts.min.css",
//     "work/src/common/mdb/css/addons-pro/steppers.min.css",
//     "work/src/common/mdb/css/addons-pro/timeline.min.css",
//     "work/src/common/mdb/css/style.css", // mdb-custom.css
//   ],
//   "public_html/common/mdb/css/compiled_mdb.css"
// );
// mix.scripts(
//   [
//     "work/src/common/mdb/js/jquery.js",
//     "work/src/common/mdb/js/popper.js",
//     "work/src/common/mdb/js/bootstrap.js",
//     "work/src/common/mdb/js/mdb.js",
//     "work/src/common/mdb/js/addons/datatables.min.js",
//     "work/src/common/mdb/js/addons/datatables2.min.js",
//     "work/src/common/mdb/js/addons/datatables-select.min.js",
//     "work/src/common/mdb/js/addons/datatables-select2.min.js",
//     "work/src/common/mdb/js/addons/directives.min.js",
//     "work/src/common/mdb/js/addons/flag.min.js",
//     "work/src/common/mdb/js/addons/imagesloaded.pkgd.min.js",
//     "work/src/common/mdb/js/addons/jquery.zmd.hierarchical-display.min.js",
//     "work/src/common/mdb/js/addons/masonry.pkgd.min.js",
//     "work/src/common/mdb/js/addons/rating.min.js",
//     "work/src/common/mdb/js/addons-pro/cards-extended.min.js",
//     "work/src/common/mdb/js/addons-pro/chat.min.js",
//     "work/src/common/mdb/js/addons-pro/multi-range.min.js",
//     "work/src/common/mdb/js/addons-pro/simple-charts.min.js",
//     "work/src/common/mdb/js/addons-pro/steppers.min.js",
//     "work/src/common/mdb/js/addons-pro/timeline.min.js",
//   ],
//   "public_html/common/js/compiled_mdb.js"
// );

if (compileCss !== "none") {
  if (["c", "all"].includes(compileCss)) {
    // c
    glob.sync("work/src/common/css/c/**/*.css").map(function(file) {
      mix.postCss(file, file.replace("work/src", "public_html")).options({
        postCss: [postcssCssVariables()],
      });
    });
  }
  if (["mypage", "all"].includes(compileCss)) {
    // mypage
    glob.sync("work/src/common/css/mypage/**/*.css").map(function(file) {
      mix.postCss(file, file.replace("work/src", "public_html")).options({
        postCss: [postcssCssVariables()],
      });
    });
  }

  if (["agent", "all"].includes(compileCss)) {
    // agent
    glob.sync("work/src/common/css/agent/**/*.css").map(function(file) {
      mix.styles(file, file.replace("work/src", "public_html"));
    });
  }
}
// JavaScript
// mix.js('path/to/file.js', 'output_path/to');

if (compileScript !== "none") {
  // Mix 6 resolves "vue-loader" by its normal package name.
  // Vue 3 requires vue-loader@17 in the normal package slot.
  const vueLoaderVersion = require("vue-loader/package.json").version;
  if (!/^1[67]\./.test(vueLoaderVersion)) {
    throw new Error(
      `Vue 3 requires vue-loader 16/17 in the normal 'vue-loader' slot; found ${vueLoaderVersion}. ` +
        "Replace the Vue 2 loader in this trial environment before building."
    );
  }

  mix.vue({ version: 3 });

  if (compileScriptFile) {
    const targetFile = `work/src/common/js/${compileScriptFile}`;
    const outputPath = `public_html/common/js/${path.dirname(compileScriptFile)}/`;
    console.log("targetFile -> ", targetFile);
    console.log("outputPath -> ", outputPath);
    mix.js(targetFile, outputPath);
  } else {
    if (["c", "all"].includes(compileScript)) {
      // c
      glob
        .sync("work/src/common/js/c/*.js", {
          ignore: [
            "work/src/common/js/c/utils.js",
            "work/src/common/js/c/master.js",
            "work/src/common/js/c/pagetop.js",
          ],
        })
        .map(function(file) {
          mix.js(file, "public_html/common/js/c/");
        });

      // c/setting
      glob.sync("work/src/common/js/c/setting/*.js").map(function(file) {
        mix.js(file, "public_html/common/js/c/setting/");
      });

      // c/mypage
      glob.sync("work/src/common/js/c/mypage/*.js").map(function(file) {
        mix.js(file, "public_html/common/js/c/mypage/");
      });
    }

    if (["mypage", "all"].includes(compileScript)) {
      // mypage
      glob
        .sync("work/src/common/js/mypage/*.js", { ignore: ["work/src/common/js/mypage/utils.js"] })
        .map(function(file) {
          mix.js(file, "public_html/common/js/mypage/");
        });
    }

    if (["agent", "all"].includes(compileScript)) {
      // agent
      glob.sync("work/src/common/js/agent/*.js", { ignore: ["work/src/common/js/agent/utils.js"] }).map(function(file) {
        mix.js(file, "public_html/common/js/agent/");
      });
    }

    mix.js("work/src/common/js/file.js", "public_html/common/js/");
  }
}

// mix.scripts(['work/src/common/js/rating_reason.js'], 'public_html/common/js/rating_reason.min.js');

// concat JavaScript
//mix.scripts([
//  'public/js/admin.js',
//  'public/js/dashboard.js'
//], 'public/js/all.js');

// if (mix.inProduction()) {
//   mix.version();
// }

// Keep the Vue 3 runtime alias after Mix generates its own webpack configuration.
mix.override((config) => {
  config.resolve ??= {};
  config.resolve.alias ??= {};
  config.resolve.alias["vue$"] = require.resolve(
    "vue/dist/vue.runtime.esm-bundler.js"
  );
});

// Vuetify 4のCSSでは、旧postcss-css-variablesによる変換を行わない。
// 既存CSSの処理はLaravel Mixが生成したルールのまま維持する。
mix.override((config) => {
  const vuetifyPath = path.dirname(
    require.resolve("vuetify/package.json")
  );

  const cssRule = config.module.rules.find(
    (rule) =>
      rule.test instanceof RegExp &&
      rule.test.test("test.css") &&
      Array.isArray(rule.oneOf)
  );

  if (!cssRule) {
    throw new Error("Laravel Mix CSS rule not found");
  }

  // CSS Modules用ではなく、通常CSS用のPostCSS分岐を取得する。
  const originalBranch = cssRule.oneOf.find((branch) =>
    branch.resourceQuery === undefined &&
    Array.isArray(branch.use) &&
    branch.use.some((entry) =>
      typeof entry === "object" &&
      entry.loader?.includes("postcss-loader")
    )
  );

  if (!originalBranch) {
    throw new Error("Laravel Mix PostCSS branch not found");
  }

  const vuetifyBranch = {
    ...originalBranch,

    // oneOfは最初に一致した分岐だけを使用する。
    // Vuetify 4のCSSだけ、この専用分岐へ送る。
    resource: (resource) =>
      typeof resource === "string" &&
      resource.startsWith(vuetifyPath + path.sep) &&
      resource.endsWith(".css"),

    use: originalBranch.use.map((entry) => {
      if (
        typeof entry !== "object" ||
        !entry.loader?.includes("postcss-loader")
      ) {
        return entry;
      }

      const plugins = entry.options?.postcssOptions?.plugins;

      if (!Array.isArray(plugins)) {
        throw new Error("PostCSS plugins not found");
      }

      return {
        ...entry,
        options: {
          ...entry.options,
          postcssOptions: {
            ...entry.options.postcssOptions,
            plugins: plugins.filter(
              (plugin) =>
                plugin.postcssPlugin !== "postcss-css-variables"
            ),
          },
        },
      };
    }),
  };

  cssRule.oneOf.unshift(vuetifyBranch);
});