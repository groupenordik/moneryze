const xml = require("xml2js");
const Promise = require("bluebird");
const axios = require("axios");
const { camelCase } = require("change-case");

Promise.promisifyAll(xml);

const globals = require("./constants/globals.json");

const xmlBuilder = new xml.Builder();

const filter = new Set([
  "res_lookup_masked",
  "res_delete",
  "completion",
  "res_update_cc",
]);
const sudo = new Set(["res_lookup_masked"]);

const cleanse = (str, spaces) => {
  let s = str;
  if (spaces) {
    s = String(s).split(" ").join("");
  }
  return (
    s
      ? String(s)
          .split("/")
          .join("")
          .split("=")
          .join("")
          .split("*")
          .join("")
          .split("!")
          .join("")
          .split("-")
          .join("")
          .trim()
      : ""
  ).replace(/\s+/g, " ");
};

/* eslint-disable-next-line no-nested-ternary */
const fe = (arr, assertion) =>
  Array.isArray(arr) && arr.length > 0 && arr[0] !== "null" && arr[0]
    ? assertion
      ? arr[0] === assertion
      : arr[0]
    : null;

const normalizeExpiry = (format, expiry) => {
  if (
    typeof format === "string" &&
    format.toLowerCase().split("/").join("") === "mmyy"
  ) {
    return (
      expiry.toString().split("").slice(2, 4).join("") +
      expiry.toString().split("").slice(0, 2).join("")
    );
  }
  return expiry;
};

const format = (data, sanitize = true) => {
  const output = {};

  const addToOutput = (name, value, assertion) => {
    const parsedValue = fe(value, assertion);

    if (parsedValue && parsedValue !== "null") {
      output[name] = parsedValue;
    }
  };

  addToOutput("reference", data.ReferenceNum);
  addToOutput("dataKey", data.DataKey);
  addToOutput("iso", data.ISO);
  addToOutput("receipt", data.ReceiptId);
  addToOutput("avsResultCode", data.AvsResultCode);
  addToOutput("cvdResultCode", data.CvdResultCode);
  addToOutput("isVisa", data.CardType, "V");
  addToOutput("isMasterCard", data.CardType, "M");
  addToOutput("isVisaDebit", data.IsVisaDebit, "true");
  addToOutput("authCode", data.AuthCode);
  addToOutput("date", data.TransDate);
  addToOutput("time", data.TransTime);
  addToOutput("amount", data.TransAmount);
  addToOutput("id", data.TransID);
  addToOutput("type", data.TransType);
  addToOutput("isComplete", data.Complete, "true");
  addToOutput("payment", data.PaymentType);
  addToOutput("resSuccess", data.ResSuccess, "true");
  addToOutput("corporateCard", data.CorporateCard, "true");
  addToOutput("recurSuccess", data.RecurSuccess, "true");
  addToOutput("resolveData", data.ResolveData);
  addToOutput("kountResult", data.KountResult);
  addToOutput("kountScore", data.KountScore);
  addToOutput("kountTransactionId", data.KountTransactionId);
  addToOutput("preloadTicket", data.PreloadTicket);
  addToOutput("cavv", data.Cavv);
  addToOutput("challengeUrl", data.ChallengeURL);
  addToOutput("challengeData", data.ChallengeData);
  addToOutput("eci", data.ECI);
  addToOutput("threeDSVersion", data.ThreeDSVersion);
  addToOutput("threeDSServerTransId", data.ThreeDSServerTransId);

  if (!sanitize) {
    addToOutput(
      "maskedPan",
      data.ResolveData ? data.ResolveData.masked_pan : null
    );
  }

  const kountInfo = fe(data.KountInfo);
  if (kountInfo && kountInfo !== "null") {
    output.kountInfo = Object.keys(kountInfo).reduce((total, current) => {
      const newTotal = { ...total };
      newTotal[camelCase(current)] = kountInfo[current].pop();
      return newTotal;
    }, {});
  }

  const code = fe(data.ResponseCode);

  return {
    isSuccess:
      !fe(data.TimedOut, "true") &&
      (code === "00" || code ? parseInt(code, 10) < 50 : false),
    code,
    msg: (output.timeout ? "TIMEOUT" : cleanse(fe(data.Message))) || "ERROR",
    data: output,
  };
};

const generateOrderId = (name) => {
  const suffix = `${new Date().getTime()}-${Math.ceil(Math.random() * 10000)}`;
  return `${cleanse(name, true)}-Transaction-${suffix}`;
};

const buildConfig = (configuration) => {
  if (!configuration.store_id || !configuration.api_token) {
    new Error("store_id and api_token are required.");
  }

  const countryCode = (configuration.country_code || "CA").toUpperCase();

  if (countryCode !== "CA" && !globals[`${countryCode}_HOST`]) {
    new Error("Invalid country code. CA, US is only supported.");
  }

  return {
    ...configuration,
    crypt_type: configuration.crypt_type || "7",
    name: configuration.name || "default",
    country_code: countryCode,
    test: configuration.test || false,
  };
};

const send = async (data, type, configuration) => {
  const config = buildConfig(configuration);

  if (!config || !config.store_id || !config.api_token) {
    return Promise.reject(new Error("configuration not initialized"));
  }

  const out = data;

  // 1. Clean up the data
  if (!filter.has(type)) {
    out.crypt_type = data.crypt_type || config.crypt_type;
    out.order_id = out.order_id || generateOrderId(config.name);
  }

  if (out.pan) {
    out.pan = cleanse(data.pan, true);
  }

  if (out.expdate) {
    out.expdate = normalizeExpiry(
      config.expiryFormat,
      cleanse(data.expdate, true)
    );
  }

  if (out.description) {
    out.dynamic_descriptor = out.description || out.dynamic_descriptor || type;
    delete out.description;
  }

  if (out.token) {
    out.data_key = out.token;
    delete out.token;
  }

  if (out.cvd_info) {
    out.cvd_info = out.cvd_info;
  }

  if (out.avs_info) {
    out.avs_info = out.avs_info;
  }

  if (type === "kount_inquiry") {
    // default values for email and ANID when they weren't specified in payload
    if (!out.email) {
      out.email = "noemail@kount.com";
    }
    if (!out.auto_number_id) {
      out.auto_number_id = "0123456789";
    }
  }

  // 2. Figure out the endpoint parameters
  const countryCode = config.country_code === "US" ? `US_` : "";
  const envCode = config.test === true ? "TEST_" : "";

  let endpointPath;
  let rootName;

  switch (type) {
    case "acs":
    case "txn":
      endpointPath = globals.MPI_FILE;
      rootName = "request";
      break;

    case "card_lookup":
    case "threeds_authentication":
    case "cavv_lookup":
      endpointPath = globals.MPI_2_FILE;
      rootName = "Mpi2Request";
      break;

    default:
      endpointPath = globals.FILE;
      rootName = "request";
      break;
  }

  // 3. Build the request
  const body = {
    store_id: config.store_id,
    api_token: config.api_token,
  };

  if (type === "attribute_query" || type === "session_query") {
    body.risk = {};
    body.risk[type] = out;
  } else {
    body[type] = out;
  }

  // 3.1 Convert to XML
  xmlBuilder.options.rootName = rootName;
  const xmlBody = xmlBuilder.buildObject(body);

  // 4. Send the request
  const host = globals[`${countryCode}${envCode}HOST`];
  const options = {
    url: `${globals.PROTOCOL}://${host}:${globals.PORT}${endpointPath}`,
    method: "POST",
    data: xmlBody,
    headers: {
      "USER-AGENT": globals.API_VERSION,
      "CONTENT-TYPE": "text/xml",
    },
    timeout: globals.CLIENT_TIMEOUT * 1000,
  };
  const response = await axios(options);

  // 5. Parse the response
  const xmlify = await xml.parseStringPromise(response.data);
  const receipt = (xmlify.response || xmlify.Mpi2Response).receipt;
  const normalizedReceipt = Array.isArray(receipt) ? receipt[0] : receipt;

  return format(normalizedReceipt, !sudo.has(type));
};

module.exports = {
  // Keep it for backward compatibility
  init: () => Promise.resolve(),

  purchase: (data, configuration) => send(data, "purchase", configuration),
  refund: (data, configuration) => send(data, "refund", configuration),

  // Preauth
  preauth: (data, configuration) => send(data, "preauth", configuration),
  completion: (data, configuration) => send(data, "completion", configuration),

  // Apple Pay
  applePayPreload: (data, configuration) =>
    send(data, "applepay_preload", configuration),

  // Vault
  resAddCC: (data, configuration) => send(data, "res_add_cc", configuration),
  resDelete: (data, configuration) => send(data, "res_delete", configuration),
  resUpdateCC: (data, configuration) =>
    send(data, "res_update_cc", configuration),
  resPurchaseCC: (data, configuration) =>
    send(data, "res_purchase_cc", configuration),
  resPreauthCC: (data, configuration) =>
    send(data, "res_preauth_cc", configuration),
  resLookupMasked: (data, configuration) =>
    send(data, "res_lookup_masked", configuration),
  independentRefundWithVault: (data, configuration) =>
    send(data, "res_ind_refund_cc", configuration),
  resTokenizeCC: (data, configuration) =>
    send(data, "res_tokenize_cc", configuration),

  // Kount
  kountInquire: (data, configuration) =>
    send(data, "kount_inquiry", configuration),
  kountUpdate: (data, configuration) =>
    send(data, "kount_update", configuration),

  // 3DS
  threedsCardLookup: (data, configuration) =>
    send(data, "card_lookup", configuration),
  threedsAuthentication: (data, configuration) =>
    send(data, "threeds_authentication", configuration),
  cavvPurchase: (data, configuration) =>
    send(data, "cavv_purchase", configuration),
  cavvLookup: (data, configuration) => send(data, "cavv_lookup", configuration),
  cavvVaultPurchase: (data, configuration) =>
    send(data, "res_cavv_purchase_cc", configuration),
};
