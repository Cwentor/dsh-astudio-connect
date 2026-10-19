window.__ModuleLoader__.load({
	id: "dsh-astudio-connect",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/status-paths.ts
		/**
		* Shared constants and web-facing types for AStudio Connect's local HTTP
		* surfaces. Node-free: imported by both the host bundle and the browser
		* client, so it must stay dependency-free.
		*
		* @module dsh-astudio-connect/status-paths
		*/
		/** Status endpoint consumed by the browser half. */
		const ASTRO_STATUS_PATH = "/astudio/status";
		/**
		* Probe control endpoint.
		*
		* Separate from the status route because it accepts writes: the status route's
		* loopback Host/Origin guard protects against a DNS-rebinding *page*, which is
		* not the same as authorizing a state-changing action. This route therefore
		* also requires the in-process key the browser half receives with the status
		* document.
		*/
		const ASTRO_PROBE_PATH = "/astudio/probe";
		//#endregion
		//#region src/client/status-document.ts
		/**
		* Narrow an unknown JSON value to {@link AStudioWebStatus}.
		*
		* Deliberately shallow: it checks the document is an object with the four
		* required sections and a valid sign-in state. It does not validate every
		* nested member, so a malformed leaf surfaces as a render-time `undefined`
		* rather than an inverted verdict — the host owns the document shape.
		*/
		function isAStudioWebStatus(value) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
			const v = value;
			if (typeof v.auth !== "object" || v.auth === null || Array.isArray(v.auth)) return false;
			if (typeof v.catalog !== "object" || v.catalog === null || Array.isArray(v.catalog)) return false;
			if (typeof v.visibility !== "object" || v.visibility === null || Array.isArray(v.visibility)) return false;
			if (typeof v.probe !== "object" || v.probe === null || Array.isArray(v.probe)) return false;
			const auth = v.auth;
			if (auth.state !== "signed-in" && auth.state !== "signed-out") return false;
			return true;
		}
		//#endregion
		//#region src/client/AStudioPluginCard.tsx
		/**
		* AStudio status card, rendered on whichever settings surface the host
		* provides: dispatched by DSH 0.1.5's settings Plugins tab, or mounted by the
		* bundle configuration page DSH 0.2.x's Plugins page renders. The component is
		* surface-agnostic — its only prop is the injected copy `t`; all data comes
		* from the same-origin status document, and all writes go through the probe
		* route keyed by the in-process probe key the document carries.
		*
		* @module dsh-astudio-connect/client/AStudioPluginCard
		*/
		/** How often the card re-reads the status document while it is open. */
		const POLL_INTERVAL_MS = 6e4;
		/** Header + body styles. Kept inline so the card renders without host CSS. */
		const cardStyle = {
			overflow: "hidden",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 10,
			background: "var(--dsw-alias-bg-module-platform)",
			listStyle: "none",
			margin: 0
		};
		const headerStyle = {
			boxSizing: "border-box",
			width: "100%",
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: 16,
			border: 0,
			padding: "13px 14px",
			background: "transparent",
			color: "var(--dsw-alias-label-primary)",
			font: "inherit",
			textAlign: "left",
			cursor: "pointer"
		};
		const headTextStyle = {
			display: "flex",
			minWidth: 0,
			flexDirection: "column",
			gap: 3
		};
		const nameStyle = {
			fontSize: 14,
			lineHeight: "20px",
			fontWeight: 600
		};
		const descriptionStyle = {
			fontSize: 13,
			lineHeight: "18px",
			color: "var(--dsw-alias-label-tertiary)"
		};
		const cardBodyStyle = {
			borderTop: "1px solid var(--dsw-alias-border-l2)",
			padding: "16px 14px 18px"
		};
		const bodyStyle = {
			margin: 0,
			fontSize: 14,
			lineHeight: "22px",
			color: "var(--dsw-alias-label-secondary)"
		};
		const rowStyle = {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			flexWrap: "wrap",
			gap: 12
		};
		const statusStyle = {
			display: "flex",
			alignItems: "center",
			gap: 9,
			fontSize: 15,
			fontWeight: 500,
			color: "var(--dsw-alias-label-primary)"
		};
		const buttonStyle = {
			boxSizing: "border-box",
			minHeight: 34,
			padding: "6px 14px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 18,
			background: "var(--dsw-alias-bg-layer-1)",
			color: "var(--dsw-alias-label-primary)",
			font: "inherit",
			fontSize: 14,
			cursor: "pointer"
		};
		const errorStyle = {
			...bodyStyle,
			color: "var(--dsw-alias-state-error-primary)"
		};
		const listStyle = {
			margin: 0,
			padding: "0 0 0 18px"
		};
		const probeRowStyle = {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: 12
		};
		const probeNameStyle = {
			display: "flex",
			alignItems: "center",
			gap: 8,
			fontSize: 13,
			lineHeight: "20px",
			color: "var(--dsw-alias-label-primary)"
		};
		const probeChipStyle = {
			padding: "1px 8px",
			borderRadius: 999,
			fontSize: 11,
			lineHeight: "18px",
			background: "var(--dsw-alias-state-success-subtle, rgba(34, 160, 107, 0.12))",
			color: "var(--dsw-alias-state-success-primary, #22a06b)"
		};
		const headingStyle = {
			margin: "12px 0 6px",
			fontSize: 14,
			lineHeight: "20px",
			fontWeight: 600,
			color: "var(--dsw-alias-label-primary)"
		};
		/**
		* Render the AStudio sign-in state and catalog as one expandable card.
		*
		* The card reads the status document on mount and every `POLL_INTERVAL_MS`
		* while open; a failed read never discards the document already on screen, and
		* a probe is a write that carries the probe key from the document.
		*/
		function AStudioPluginCard({ t }) {
			const [open, setOpen] = (0, react.useState)(false);
			const [status, setStatus] = (0, react.useState)();
			const [readFailure, setReadFailure] = (0, react.useState)();
			const [busy, setBusy] = (0, react.useState)(false);
			const mounted = (0, react.useRef)(true);
			const readSeq = (0, react.useRef)(0);
			(0, react.useEffect)(() => {
				mounted.current = true;
				return () => {
					mounted.current = false;
				};
			}, []);
			/**
			* Read the status document and apply it.
			*
			* A non-document body is a failed read, not something to store and then
			* dereference in the render; a failed read never discards a document already
			* on screen. Returns whether this read produced the current document.
			*/
			const refresh = (0, react.useCallback)(async (signal) => {
				const seq = ++readSeq.current;
				const current = () => mounted.current && signal?.aborted !== true && seq === readSeq.current;
				try {
					const response = await fetch(ASTRO_STATUS_PATH, {
						headers: { accept: "application/json" },
						credentials: "same-origin",
						...signal === void 0 ? {} : { signal }
					});
					const value = await response.json().catch(() => void 0);
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					if (!isAStudioWebStatus(value)) throw new Error(t("statusResponseInvalid"));
					if (!current()) return false;
					setStatus(value);
					setReadFailure(void 0);
					return true;
				} catch (error) {
					const message = error instanceof Error ? error.message : t("requestFailed");
					if (current()) setReadFailure(message);
					return false;
				}
			}, [t]);
			(0, react.useEffect)(() => {
				if (!open) return;
				const controller = new AbortController();
				refresh(controller.signal);
				const timer = setInterval(() => {
					refresh(controller.signal);
				}, POLL_INTERVAL_MS);
				return () => {
					clearInterval(timer);
					controller.abort();
				};
			}, [open, refresh]);
			/**
			* Run one probe and refresh the card afterwards.
			*
			* The probe key travels in a header, not the body: it authorizes the write,
			* and the host never accepts a probe for a model outside its own catalog.
			*/
			const runProbe = (0, react.useCallback)(async (modelId) => {
				const key = status?.probeKey;
				if (key === void 0) return;
				setBusy(true);
				try {
					const response = await fetch(`${ASTRO_PROBE_PATH}/${modelId}`, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"x-astudio-probe-key": key
						},
						credentials: "same-origin",
						body: JSON.stringify({ effort: "low" })
					});
					if (!response.ok) {
						const value = await response.json().catch(() => void 0);
						const message = typeof value === "object" && value !== null && "error" in value ? String(value.error) : `HTTP ${response.status}`;
						throw new Error(message);
					}
				} catch (error) {
					if (mounted.current) setReadFailure(error instanceof Error ? error.message : t("requestFailed"));
					return;
				} finally {
					if (mounted.current) setBusy(false);
				}
				await refresh();
			}, [
				status,
				refresh,
				t
			]);
			const label = status === void 0 ? t("loading") : status.auth.state === "signed-in" ? t("signedIn") : t("signedOut");
			const catalogSource = status === void 0 ? "" : status.catalog.source === "live" ? t("catalogLive") : status.catalog.source === "saved" ? t("catalogSaved") : t("catalogFallback");
			const models = status === void 0 ? [] : status.catalog.models;
			const probeResults = status === void 0 ? [] : status.probe.results;
			const signedIn = status?.auth.state === "signed-in";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				style: cardStyle,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					style: headerStyle,
					"aria-expanded": open,
					"aria-label": `${t("refresh")}: ${t("title")}`,
					onClick: () => {
						setOpen(!open);
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: headTextStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: nameStyle,
							children: t("title")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: descriptionStyle,
							children: t("intro")
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						"aria-hidden": "true",
						style: { transform: open ? "rotate(180deg)" : "none" },
						children: "⌄"
					})]
				}), open ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: cardBodyStyle,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							style: headingStyle,
							children: t("accountHeading")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: rowStyle,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: statusStyle,
								role: "status",
								"aria-busy": status === void 0,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									"aria-hidden": "true",
									children: "●"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label })]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: buttonStyle,
								disabled: busy,
								onClick: () => {
									refresh();
								},
								children: busy ? t("refreshing") : t("refresh")
							})]
						}),
						catalogSource !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: bodyStyle,
							children: catalogSource
						}) : null,
						readFailure !== void 0 && status !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: errorStyle,
							children: readFailure
						}) : null,
						signedIn ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
								style: headingStyle,
								children: t("contextHeading")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
								style: listStyle,
								children: models.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
									style: bodyStyle,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: model.name })
								}, model.id))
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
								style: headingStyle,
								children: t("probeHeading")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: probeRowStyle,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: bodyStyle,
									children: probeResults.length === 0 ? t("probeNoResult") : probeResults.map((r) => r.modelId).join(", ")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: probeNameStyle,
									children: models.map((model) => {
										const result = probeResults.find((r) => r.modelId === model.id);
										return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											style: probeRowStyle,
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: model.name }),
												result === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
													style: probeChipStyle,
													children: [
														result.validation,
														": ",
														result.efforts.join("/")
													]
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													style: buttonStyle,
													disabled: busy || status?.probeKey === void 0,
													onClick: () => {
														runProbe(model.id);
													},
													children: result === void 0 ? t("probeStart") : t("probeRedetect")
												})
											]
										}, model.id);
									})
								})]
							})
						] }) : status !== void 0 && readFailure !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: errorStyle,
							children: readFailure
						}) : null
					]
				}) : null]
			});
		}
		//#endregion
		//#region src/client/AStudioConfigPage.tsx
		/** The page's own chrome: a single card, no other chrome from the host. */
		const pageStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 12,
			listStyle: "none",
			margin: 0,
			padding: 0
		};
		/**
		* Render the bundle's configuration: one status card.
		*
		* Only `view: 'page'` is asked for on this slot today; the one-liner answer
		* keeps the bundle legible if a summary seat ever renders it.
		*/
		function AStudioConfigPage({ view, t }) {
			if (view === "summary") return t("intro");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
				style: pageStyle,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AStudioPluginCard, { t })
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/**
		* AStudio Connect settings card copy, per UI language.
		*
		* One namespace (`settings.astudio`) feeds the card through the injected `t`
		* seat. The key union is derived from the English dictionary so a copy key can
		* never be added to one language without the other.
		*
		* @module dsh-astudio-connect/client/locales
		*/
		/** English copy. */
		const en = {
			title: "AStudio Connect",
			intro: "Reuse models signed in to the AStudio app",
			loading: "Loading…",
			refresh: "Refresh",
			refreshing: "Refreshing…",
			accountHeading: "Account",
			signedIn: "Signed in",
			signedOut: "Not signed in",
			catalogLive: "Live catalog",
			catalogSaved: "Saved catalog",
			catalogFallback: "Built-in catalog",
			contextHeading: "Context",
			detailHeading: "Detail",
			rate: "Rate",
			rateUnknown: "Unknown",
			probeHeading: "Probe",
			probeStart: "Probe",
			probeRedetect: "Re-probe",
			probeUnknown: "Unknown",
			probeNoResult: "No probe results yet",
			requestFailed: "Request failed",
			statusResponseInvalid: "Status document invalid"
		};
		/** Simplified Chinese copy. */
		const zh = {
			title: "AStudio Connect",
			intro: "复用 AStudio 应用中已登录的模型",
			loading: "加载中…",
			refresh: "刷新",
			refreshing: "刷新中…",
			accountHeading: "账户",
			signedIn: "已登录",
			signedOut: "未登录",
			catalogLive: "实时目录",
			catalogSaved: "已保存目录",
			catalogFallback: "内置目录",
			contextHeading: "上下文",
			detailHeading: "详情",
			rate: "速率",
			rateUnknown: "未知",
			probeHeading: "探测",
			probeStart: "探测",
			probeRedetect: "重新探测",
			probeUnknown: "未知",
			probeNoResult: "暂无探测记录",
			requestFailed: "请求失败",
			statusResponseInvalid: "状态文档无效"
		};
		//#endregion
		//#region src/client/index.tsx
		/** Stable browser-plugin name. */
		const name = "dsh-astudio-connect-client";
		/**
		* The bundle's package name, which is also this half's configuration key.
		*
		* The Plugins page dispatches `plugins.bundle.config` by the bundle's package
		* name, so the key has to spell exactly what the profile installs.
		*/
		const BUNDLE_NAME = "dsh-astudio-connect";
		/**
		* Client services required by this browser half.
		*
		* The `slots` registry lives in `@deepseek-ai/dsh-client-ui-renderer` and
		* `locale` in `@deepseek-ai/dsh-client-locale`. Neither slot owner is named
		* here on purpose: the seam choice is made by slot-declaration lifetime, not by
		* activation order — `ctx.slots.inject` fires whenever the declaring package
		* commits the slot, before or after this fiber starts.
		*/
		const inject = ["slots", "locale"];
		/** Prefix every guarded client contribution's degradation logs with this. */
		const CLIENT_CONTRIBUTION_FAILED = "[dsh-astudio-connect] client contribution failed to load (host provider unaffected):";
		/** Disposer handed back when a deferred registration degraded: nothing to undo. */
		const NOOP_DISPOSER = () => {};
		/**
		* Run ONE browser-side contribution, degrading its failure to a `console.error`
		* instead of throwing into the DSH loader. Returns the contribution's own value
		* on success, or `undefined` when it degraded — the deferred slot callbacks
		* below substitute `NOOP_DISPOSER` for that, because the slot runtime always
		* expects a disposer back.
		*
		* Every contribution is guarded at BOTH boundaries where it can throw:
		*
		* 1. the eager `ctx.slots.inject(...)` call, which runs synchronously inside
		*    `apply()`;
		* 2. the deferred callback, which the slot runtime invokes later — when the
		*    owner commits the slot's declaration — long after `apply()` has returned,
		*    where no enclosing try/catch could still catch it.
		*
		* The pair makes the contributions independent: a failure in one settings seam
		* leaves the other registration intact. Guards are for THIS browser half only;
		* the host half reports its own errors through `ctx.logger`.
		*/
		function guardClientContribution(label, fn) {
			try {
				return fn();
			} catch (error) {
				console.error(`${CLIENT_CONTRIBUTION_FAILED} ${label}`, error);
				return;
			}
		}
		/**
		* Register the card copy and both settings-surface seams, one guarded
		* contribution at a time.
		*
		* A DSH slot-API breaking change degrades to a `console.error` per contribution
		* instead of throwing into the DSH loader and raising the red "Failed to load
		* plugins" banner; because each contribution carries its own guard, one failing
		* registration never takes the others with it. The host provider keeps working
		* throughout.
		*/
		function apply(ctx) {
			const namespace = "settings.astudio";
			guardClientContribution("settings copy", () => {
				ctx.effect(() => ctx.locale.register(namespace, {
					zh,
					en
				}), "dsh-astudio-connect: settings copy");
			});
			const t = ctx.locale.bind(namespace);
			guardClientContribution("plugins.bundle.config page", () => {
				ctx.slots.inject("plugins.bundle.config", () => guardClientContribution("plugins.bundle.config page", () => ctx.slots.register({
					name: "plugins.bundle.config",
					key: "dsh-astudio-connect",
					locale: namespace
				}, AStudioConfigPage)) ?? NOOP_DISPOSER);
			});
			guardClientContribution("settings.plugin.item card", () => {
				ctx.slots.inject("settings.plugin.item", () => guardClientContribution("settings.plugin.item card", () => ctx.slots.register({
					name: "settings.plugin.item",
					key: "astudio",
					priority: 30,
					inject: () => ({ t })
				}, AStudioPluginCard)) ?? NOOP_DISPOSER);
			});
		}
		/**
		* Desensitize a token for display: show only the first 7 characters and the
		* length, never the full value. Kept exported for host diagnostics and tests.
		*/
		function desensitizeToken(token) {
			if (token === void 0) return "—";
			if (token.length <= 7) return `${token}… (len=${token.length})`;
			return `${token.slice(0, 7)}… (len=${token.length})`;
		}
		//#endregion
		exports.BUNDLE_NAME = BUNDLE_NAME;
		exports.apply = apply;
		exports.desensitizeToken = desensitizeToken;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
