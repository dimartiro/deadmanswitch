import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, Routes, Route } from "react-router-dom";
import App from "./App";
import "./index.css";

const HomePage = lazy(() => import("./pages/HomePage"));
const WillsPage = lazy(() => import("./pages/WillsPage"));
const CreateWillPage = lazy(() => import("./pages/CreateWillPage"));
const AccountsPage = lazy(() => import("./pages/AccountsPage"));
const IdentityPage = lazy(() => import("./pages/IdentityPage"));
const CertificatesPage = lazy(() => import("./pages/CertificatesPage"));

const routeFallback = (
	<div className="card animate-pulse">
		<div className="h-4 w-32 rounded bg-white/[0.06]" />
		<div className="mt-3 h-3 w-48 rounded bg-white/[0.04]" />
	</div>
);

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<HashRouter>
			<Routes>
				<Route element={<App />}>
					<Route
						index
						element={
							<Suspense fallback={routeFallback}>
								<HomePage />
							</Suspense>
						}
					/>
					<Route
						path="dashboard"
						element={
							<Suspense fallback={routeFallback}>
								<WillsPage />
							</Suspense>
						}
					/>
					<Route
						path="create"
						element={
							<Suspense fallback={routeFallback}>
								<CreateWillPage />
							</Suspense>
						}
					/>
					<Route
						path="accounts"
						element={
							<Suspense fallback={routeFallback}>
								<AccountsPage />
							</Suspense>
						}
					/>
					<Route
						path="identity"
						element={
							<Suspense fallback={routeFallback}>
								<IdentityPage />
							</Suspense>
						}
					/>
					<Route
						path="certificates"
						element={
							<Suspense fallback={routeFallback}>
								<CertificatesPage />
							</Suspense>
						}
					/>
				</Route>
			</Routes>
		</HashRouter>
	</StrictMode>,
);
