window.__ModuleLoader__.load({
	id: "dsh-astudio-connect",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperties(exports, {
			__esModule: { value: true },
			[Symbol.toStringTag]: { value: "Module" }
		});
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/index.tsx
		/**
		* AStudio settings page. Shows connection status, desensitized token info,
		* and the model list. Rendered into the DSH plugin settings slot.
		*
		* @module dsh-astudio-connect/client
		*/
		/**
		* Desensitize a token for display: show only the first 7 characters and
		* the length, never the full value.
		*/
		function desensitizeToken(token) {
			if (token === void 0) return "—";
			if (token.length <= 7) return `${token}… (len=${token.length})`;
			return `${token.slice(0, 7)}… (len=${token.length})`;
		}
		/**
		* AStudio settings page component.
		*
		* Shows:
		* - Connection status (connected / not connected)
		* - Desensitized token info
		* - Model list from the catalog
		*/
		function AStudioSettingsPage({ store, catalog }) {
			const [status, setStatus] = (0, react.useState)("not-connected");
			const [tokenInfo, setTokenInfo] = (0, react.useState)("—");
			const [models, setModels] = (0, react.useState)([]);
			(0, react.useEffect)(() => {
				const token = store.resolve();
				if (token !== void 0) {
					setStatus("connected");
					setTokenInfo(desensitizeToken(token));
				} else {
					setStatus("not-connected");
					setTokenInfo("—");
				}
				setModels(catalog.current());
			}, [store, catalog]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					padding: "16px",
					fontFamily: "system-ui, sans-serif"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
						style: { marginBottom: "12px" },
						children: "AStudio Connect"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: { marginBottom: "12px" },
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: { fontWeight: "bold" },
							children: "Status: "
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: { color: status === "connected" ? "green" : "red" },
							children: status === "connected" ? "Connected" : "Not connected"
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: { marginBottom: "12px" },
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: { fontWeight: "bold" },
							children: "Token: "
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: tokenInfo })]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: { fontWeight: "bold" },
						children: [
							"Models (",
							models.length,
							"):"
						]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						style: { marginTop: "8px" },
						children: models.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
							style: { marginBottom: "4px" },
							children: [
								model.name,
								" ",
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("code", { children: [
									"(",
									model.id,
									")"
								] })
							]
						}, model.id))
					})] })
				]
			});
		}
		//#endregion
		exports.default = AStudioSettingsPage;
		exports.desensitizeToken = desensitizeToken;
		return module.exports;
	}
});
