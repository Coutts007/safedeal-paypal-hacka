"use client";

export default function LogoutButton() {
  return (
    <button
      type="button"
      className="text-sm text-neutral-600 underline"
      onClick={async () => {
        await fetch("/api/admin/logout", { method: "POST" });
        window.location.href = "/admin";
      }}
    >
      Log out
    </button>
  );
}
