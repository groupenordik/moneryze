module.exports = {
  extends: ["airbnb", "prettier"],
  parser: "@babel/eslint-parser",
  parserOptions: {
    requireConfigFile: false,
    babelOptions: {
      babelrc: false,
      configFile: false,
    },
  },
  env: {
    browser: true,
    commonjs: true,
    es6: true,
    jest: true,
    node: true,
  },
  rules: {
    "no-restricted-syntax": "off",
    "no-await-in-loop": "off",
    "import/extensions": 0,
    "import/prefer-default-export": 0,
    import: 0,
    "prefer-const": [
      "error",
      {
        destructuring: "all",
      },
    ],
    quotes: [
      2,
      "single",
      {
        avoidEscape: true,
        allowTemplateLiterals: true,
      },
    ],
    "prettier/prettier": [
      "error",
      {
        tabWidth: 2,
        useTabs: false,
        printWidth: 160,
        singleQuote: true,
        trailingComma: "all",
        endOfLine: "lf",
      },
    ],
    "max-len": 0,
    "no-console": "off",
  },
  plugins: ["html", "prettier"],
};
