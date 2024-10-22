const EnvDebug = () => {
  return (
    <div className="fixed bottom-0 right-0 bg-black text-white p-2 text-xs">
      Backend URL: {process.env.NEXT_PUBLIC_BACKEND_URL || "not set"}
    </div>
  );
};

export default EnvDebug;
