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
		//#region src/identity.ts
		/**
		* Local identity for AStudio Connect.
		*
		* AStudio's config token does not carry a stable user id, so per-account
		* catalog, visibility, and probe persistence collapses to one local identity.
		*
		* @module dsh-astudio-connect/identity
		*/
		/** Stable local identity used by all AStudio Connect persistence. */
		const ASTRO_LOCAL_IDENTITY = "astudio-local";
		//#endregion
		//#region src/client/index.tsx
		/**
		* AStudio settings page. Renders the plugin card into the DSH settings slot with
		* three labeled sections — status, context, and detail — plus manual refresh,
		* probe, and visibility controls.
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
		/** AStudio settings page component. */
		function AStudioSettingsPage({ store, catalog, visibility, probe, identity = ASTRO_LOCAL_IDENTITY, onProbe }) {
			const [status, setStatus] = (0, react.useState)("not-connected");
			const [models, setModels] = (0, react.useState)([]);
			const [refreshing, setRefreshing] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				const token = store.resolve();
				setStatus(token !== void 0 ? "connected" : "not-connected");
				setModels(catalog.current());
			}, [store, catalog]);
			async function refreshCatalog() {
				setRefreshing(true);
				try {
					await catalog.refresh();
					setModels(catalog.current());
				} finally {
					setRefreshing(false);
				}
			}
			const hidden = visibility === void 0 ? [] : visibility.hidden(identity);
			const probeRecords = (probe === void 0 ? [] : catalog.current()).map((model) => probe === void 0 ? void 0 : probe.get(identity, model.id)).filter((record) => record !== void 0);
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
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						style: { marginBottom: "12px" },
						"data-testid": "status",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
								style: { marginBottom: "8px" },
								children: "Status"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: { marginBottom: "4px" },
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: { fontWeight: "bold" },
									children: "Sign-in: "
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: { color: status === "connected" ? "green" : "red" },
									children: status === "connected" ? "Connected" : "Not connected"
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: { marginBottom: "4px" },
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: { fontWeight: "bold" },
									children: "Catalog source: "
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: catalog.source() })]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: { fontWeight: "bold" },
								children: "Token expiry: "
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "Unknown" })] })
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						style: { marginBottom: "12px" },
						"data-testid": "context",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
							style: { marginBottom: "8px" },
							children: "Context"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", { children: models.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
							style: { marginBottom: "4px" },
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
								model.name,
								": ",
								model.contextWindow,
								" tokens, image ",
								model.supportsImages === true ? "supported" : "not supported"
							] })
						}, model.id)) })]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						style: { marginBottom: "12px" },
						"data-testid": "detail",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
								style: { marginBottom: "8px" },
								children: "Detail"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: { marginBottom: "8px" },
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: { fontWeight: "bold" },
									children: "Rate: "
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "Unknown" })]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", { children: models.map((model) => {
								const record = probeRecords.find((r) => r.modelId === model.id);
								return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
									style: { marginBottom: "4px" },
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
										model.name,
										" ",
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("code", { children: [
											"(",
											model.id,
											")"
										] })
									] }), record !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										style: { marginLeft: "8px" },
										children: [
											"probe: ",
											record.validation,
											" [",
											record.efforts.join(", "),
											"]"
										]
									})]
								}, model.id);
							}) })
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: { marginBottom: "12px" },
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							onClick: () => void refreshCatalog(),
							disabled: refreshing,
							children: refreshing ? "Refreshing…" : "Refresh catalog"
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: { marginBottom: "12px" },
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: { fontWeight: "bold" },
							children: "Probe:"
						}), models.filter((model) => model.reasoning?.supports === true).map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: { marginLeft: "8px" },
							onClick: () => onProbe?.(model.id),
							children: model.name
						}, model.id))]
					}),
					visibility !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: { fontWeight: "bold" },
						children: "Visibility:"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", { children: models.map((model) => {
						const isHidden = hidden.includes(model.id);
						return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							onClick: async () => {
								await visibility.setVisible(identity, model.id, !isHidden);
							},
							children: [
								isHidden ? "Show" : "Hide",
								" ",
								model.name
							]
						}) }, model.id);
					}) })] })
				]
			});
		}
		//#endregion
		exports.default = AStudioSettingsPage;
		exports.desensitizeToken = desensitizeToken;
		return module.exports;
	}
});
