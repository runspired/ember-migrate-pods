const execa = require("execa");
const codeshift = require("jscodeshift");
const globby = require("globby");
const path = require("path");
const fs = require("fs");

const APP_NAME = "frontend";
const REWRITE_RELATIVE_TO_ABSOLUTE = false;
const DRY_RUN = false;

const TYPES = [
  { fileName: "adapter" },
  { fileName: "component", alsoMoveTemplate: true },
  { fileName: "helper" },
  { fileName: "mixin" },
  { fileName: "initializer" },
  { fileName: "instance-initializer" },
  { fileName: "model" },
  { fileName: "route", preserveName: true, alsoMoveTemplate: true },
  {
    fileName: "controller",
    preserveName: true,
    baseName: "routes",
    alsoMoveTemplate: true,
  },
  { fileName: "serializer" },
  { fileName: "service" },
  { fileName: "transform" },
  // unknown templates ?
];
const CONVERSIONS = {};
const MIGRATIONS = [];
const COMPLETED = {};

function toImportPath(str) {
  str = str.replace("app/", `${APP_NAME}/`);
  let ext = path.extname(str);
  if (ext) {
    str = str.replace(ext, "");
  }
  return str;
}

function filePathToImportPath(from) {
  let f = path.dirname(from);
  f = f.replace("app/", `${APP_NAME}/`);
  return f;
}

function buildFullPath(filePath, relativePath) {
  let f = filePathToImportPath(filePath);
  if (relativePath.startsWith(".")) {
    return toImportPath(path.join(f, relativePath));
  }
  return relativePath;
}

function getRelativeImportPath(from, to) {
  let f = filePathToImportPath(from);
  let r = path.relative(f, to);
  if (!r.startsWith(".")) {
    return "./" + r;
  }
  return r;
}

function updateImportPaths(migration, conversions) {
  const filePath = migration.to;
  const code = fs.readFileSync(filePath, { encoding: "utf-8" });
  let hasChanges = false;

  const output = codeshift(code)
    .find(codeshift.ImportDeclaration)
    .forEach((path) => {
      let value = path.value.source.value;
      let importPath = buildFullPath(migration.from, value);
      let updatedPath = conversions[importPath];
      let isRelativePath = value.startsWith(".");
      let updatedValue;

      // if we want to rewrite all relative to absolute then we have less work to do
      if (isRelativePath && REWRITE_RELATIVE_TO_ABSOLUTE) {
        updatedValue = updatedPath || importPath;
        console.log(
          "\tupdate to absolute import location",
          value,
          updatedValue
        );

        // check if the file has moved relative to us
      } else if (updatedPath) {
        let newPath = updatedPath;
        if (isRelativePath) {
          newPath = getRelativeImportPath(migration.to, newPath);
        }
        updatedValue = newPath;
        console.log("\tupdate import location", value, newPath);

        // check if we have moved relative to the file
      } else if (isRelativePath) {
        let newRelativePath = getRelativeImportPath(migration.to, importPath);
        let oldRelativePath = getRelativeImportPath(migration.from, importPath);

        if (newRelativePath !== oldRelativePath) {
          updatedValue = newRelativePath;
          console.log("\tupdate relative path", value, newRelativePath);
        }
      }

      if (updatedValue) {
        hasChanges = true;
        path.value.source.value = updatedValue;
      }
    })
    .toSource();

  if (!DRY_RUN && hasChanges) {
    fs.writeFileSync(filePath, output);
  } else if (hasChanges) {
    console.log("\n\n", output, "\n\n");
  }
}

function getSiblingTemplatePath(target) {
  let potentialTemplatePath = path.join(path.dirname(target), "template.hbs");
  let exists = false;
  try {
    fs.lstatSync(potentialTemplatePath);
    exists = true;
  } catch (e) {
    exists = false;
  }

  if (exists) {
    return potentialTemplatePath;
  }
}

function makeDir(target) {
  let dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
}

async function run(options) {
  let filesToMigrate;
  try {
    filesToMigrate = await globby(`app/**/${options.fileName}.js`);
  } catch (e) {
    if (e.message.indexOf("No such file or directory") === -1) {
      throw e;
    }
    console.log(`No files found for the glob 'app/**/${options.fileName}.js'`);
    return;
  }

  const migrations = MIGRATIONS;
  const conversions = CONVERSIONS;

  filesToMigrate.forEach((from) => {
    let dirname = path.dirname(from);
    dirname = dirname.replace("app/", "");
    let to;
    let baseName = options.baseName ? options.baseName : `${options.fileName}s`;

    if (dirname.startsWith(`${baseName}/`)) {
      dirname = dirname.replace(`${baseName}/`, "");
    }

    if (options.preserveName) {
      to = `app/${baseName}/${dirname}/${options.fileName}.js`;
    } else {
      to = `app/${baseName}/${dirname}.js`;
    }

    if (from === to) {
      return;
    }

    conversions[toImportPath(from)] = toImportPath(to);
    migrations.push({
      from,
      to,
    });

    if (options.alsoMoveTemplate) {
      let templatePath = getSiblingTemplatePath(from);
      let to;

      if (options.preserveName) {
        to = `app/${baseName}/${dirname}/template.hbs`;
      } else {
        to = `app/${baseName}/${dirname}.hbs`;
      }

      if (templatePath) {
        conversions[toImportPath(templatePath)] = toImportPath(to);
        migrations.push({
          from: templatePath,
          to,
        });
      }
    }
  });
}

async function fixImportPaths(migrations, conversions) {
  console.log("fixing import paths");
  migrations.forEach((m) => {
    if (m.from.endsWith(".js")) {
      updateImportPaths(m, conversions);
    }
  });
  if (!DRY_RUN) {
    console.log("done fixing import paths");
    await execa(
      `git add -A && git commit -m "migration: update file import paths"`,
      { shell: true, preferLocal: true }
    );
  }
}

async function renameFiles(migrations) {
  console.log("renaming files");
  migrations.forEach((m) => {
    // templates may be added twice when both route and controller exist
    if (COMPLETED[m.from]) {
      return;
    }
    COMPLETED[m.from] = true;

    console.log(`\t${m.from} => ${m.to}`);

    if (!DRY_RUN) {
      makeDir(m.to);
      fs.renameSync(m.from, m.to);
    }
  });
  if (!DRY_RUN) {
    console.log("done renaming files");
    await execa(
      `git add -A && git commit -m "migration: restructure file locations"`,
      { shell: true, preferLocal: true }
    );
  }
}

async function runAll() {
  let status = await execa("git status", { shell: true, preferLocal: true });
  if (!status.stdout.match(/^nothing to commit/m)) {
    console.log(
      `Directory is not in a clean working state. Commiting any outstanding changes prior to running this script.`
    );
    if (!DRY_RUN) {
      try {
        await execa(
          `git add -A && git commit -m "pre-migration: unsaved changes from working state prior to script exec"`,
          { shell: true, preferLocal: true }
        );
      } catch (e) {
        console.log(e);
        return;
      }
    }
  }

  for (let i = 0; i < TYPES.length; i++) {
    let config = TYPES[i];
    console.log("Analyzing " + config.fileName);
    await run(config);
  }

  await renameFiles(MIGRATIONS);
  await fixImportPaths(MIGRATIONS, CONVERSIONS);
}

runAll();
