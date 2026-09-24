import type { Metadata } from "next";
import { Suspense } from "react";
import { LoginForm } from "@/components/layout/login-form";
import { Logo } from "@/components/layout/logo";

export const metadata: Metadata = { title: "Admin login" };

export default function LoginPage() {
  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex justify-center">
          <Logo />
        </div>
        <Suspense>
          <LoginForm />
        </Suspense>
      </div>
    </main>
  );
}
