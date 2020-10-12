import path from "path";
import { createHash } from "crypto";
import { types as t } from "@marko/babel-types";
import { getLoc, ___setTaglibLookup } from "@marko/babel-utils";
import { buildLookup } from "../taglib";
import { parseMarko } from "./parser";
import { visitor as migrate } from "./plugins/migrate";
import { visitor as transform } from "./plugins/transform";
import traverse, { visitors } from "@babel/traverse";
import { getRootDir } from "lasso-package-root";
import markoModules from "../../modules";
import { MarkoFile } from "./file";

const TEMP_METADATA_FOR_AST = new WeakMap();
let ROOT = process.cwd();
try {
  ROOT = getRootDir(ROOT);
  // eslint-disable-next-line no-empty
} catch {}

export default (api, markoOpts) => {
  api.assertVersion(7);
  const userCache = markoOpts.cache;
  const fs = markoOpts.fileSystem;
  const translator = markoOpts.translator;

  markoOpts.output = markoOpts.output || "html";

  if (markoOpts.optimize === undefined) {
    markoOpts.optimize = api.env("production");
  }

  if (!translator || !translator.visitor) {
    throw new Error(
      "@marko/compiler: translator must provide a visitor object"
    );
  }

  return {
    name: "marko",
    parserOverride(code, jsParseOptions) {
      let compileCache = userCache.get(translator);

      if (!compileCache) {
        userCache.set(translator, (compileCache = new Map()));
      }

      const filename = jsParseOptions.sourceFileName;
      const componentId = path.relative(ROOT, filename);
      const contentHash = createHash("MD5")
        .update(code)
        .digest("hex");
      const cacheKey = createHash("MD5")
        .update(componentId)
        .update(markoOpts.migrate ? "\0" : "")
        .digest("hex");

      let cached = compileCache.get(cacheKey);

      if (cached) {
        if (cached.contentHash !== contentHash) {
          // File content changed, invalidate the cache.
          cached = undefined;
        } else {
          for (const watchFile of cached.meta.watchFiles) {
            let mtime = Infinity;
            try {
              mtime = fs.statSync(watchFile).mtime;
              // eslint-disable-next-line no-empty
            } catch {}

            if (mtime > cached.time) {
              // Some dependency changed, invalidate the cache.
              cached = undefined;
              break;
            }
          }
        }
      }

      let ast;
      let meta;

      if (cached) {
        ast = t.cloneDeep(cached.ast);
        meta = cloneMeta(cached.meta);
      } else {
        ast = {
          type: "File",
          program: {
            type: "Program",
            sourceType: "module",
            body: [],
            directives: []
          }
        };

        meta = {
          id: componentId,
          macros: {},
          deps: [],
          tags: [],
          watchFiles: new Set()
        };
      }

      const file = new MarkoFile(jsParseOptions, { code, ast });

      file.metadata.marko = meta;
      file.markoOpts = markoOpts;

      const taglibLookup = buildLookup(
        path.dirname(filename),
        markoOpts.translator
      );
      ___setTaglibLookup(file, taglibLookup);

      if (!cached) {
        const rootMigrators = Object.values(taglibLookup.taglibsById)
          .map(({ migratorPath }) => {
            if (migratorPath) {
              const mod = markoModules.require(migratorPath);
              meta.watchFiles.add(migratorPath);
              return (mod.default || mod)(api, markoOpts);
            }
          })
          .filter(Boolean);

        const rootTransformers = taglibLookup.merged.transformers.map(
          ({ path: transformerPath }) => {
            const mod = markoModules.require(transformerPath);
            meta.watchFiles.add(transformerPath);
            return (mod.default || mod)(api, markoOpts);
          }
        );

        file.ast.start = file.ast.program.start = 0;
        file.ast.end = file.ast.program.end = code.length - 1;
        file.ast.loc = file.ast.program.loc = {
          start: { line: 0, column: 0 },
          end: getLoc(file, file.ast.end)
        };

        parseMarko(file);
        file.path.scope.crawl(); // Initialize bindings.

        traverse(
          file.ast,
          rootMigrators.length
            ? visitors.merge(rootMigrators.concat(migrate))
            : migrate,
          file.scope
        );

        traverse(
          file.ast,
          rootTransformers.length
            ? visitors.merge(rootTransformers.concat(transform))
            : transform,
          file.scope
        );

        compileCache.set(cacheKey, {
          ast: t.cloneDeep(file.ast),
          meta: cloneMeta(meta),
          contentHash,
          time: Date.now()
        });
      }

      if (markoOpts._translate !== false) {
        if (cached) {
          file.path.scope.crawl(); // Initialize bindings.
        }

        traverse(file.ast, translator.visitor, file.scope);
      }

      const result = t.cloneDeep(file.ast);

      for (const taglibId in taglibLookup.taglibsById) {
        const { filePath } = taglibLookup.taglibsById[taglibId];

        if (
          filePath[filePath.length - 5] === "." &&
          filePath.endsWith("marko.json")
        ) {
          meta.watchFiles.add(filePath);
        }
      }

      file.metadata.marko.watchFiles = Array.from(
        file.metadata.marko.watchFiles
      );

      TEMP_METADATA_FOR_AST.set(result, file.metadata.marko);

      return result;
    },
    pre(file) {
      // Copy over the Marko specific metadata.
      file.metadata.marko = TEMP_METADATA_FOR_AST.get(file.ast);
    }
  };
};

function cloneMeta(meta) {
  return {
    id: meta.id,
    macros: { ...meta.macros },
    deps: meta.deps.slice(),
    tags: meta.tags.slice(),
    watchFiles: new Set(meta.watchFiles)
  };
}
