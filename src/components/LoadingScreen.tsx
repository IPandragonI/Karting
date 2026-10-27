import Image from "next/image";

export function LoadingScreen({ progress }: { progress: number }) {
  return (
    <div className="absolute inset-0 grid place-items-center bg-base-200">
      <div className="flex w-64 flex-col items-center gap-4">
        <Image src="/logo.png" alt="" width={128} height={128} preload className="rounded-3xl" />
        <p className="text-2xl font-extrabold tracking-tight">
          Low-Poly <span className="text-primary">Karting</span>
        </p>
        <progress
          className="progress w-full progress-primary"
          value={Math.round(progress * 100)}
          max={100}
          aria-label="Loading"
        />
      </div>
    </div>
  );
}
