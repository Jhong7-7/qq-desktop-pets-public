"""Build the Coo Console APK from source without Gradle / Android Studio.

Toolchain layout (all portable, all under BASE):
  jdk/jdk-17/                     JDK 17
  platform/android-35/android.jar  framework
  buildtools/android-15/          aapt2, d8, zipalign, apksigner
  src/                            manifest, java, res
"""
import glob
import os
import shutil
import subprocess
import sys
import zipfile

BASE = os.environ.get("COO_APK_TOOLS", "C:/Users/86189/AppData/Local/Temp/cooapk")
JDK = BASE + "/jdk/jdk-17"
JAVAC = JDK + "/bin/javac.exe"
JAVA = JDK + "/bin/java.exe"
KEYTOOL = JDK + "/bin/keytool.exe"
BT = BASE + "/buildtools/android-15"
AAPT2 = BT + "/aapt2.exe"
ZIPALIGN = BT + "/zipalign.exe"
D8_JAR = BT + "/lib/d8.jar"
APKSIGNER_JAR = BT + "/lib/apksigner.jar"
ANDROID_JAR = BASE + "/platform/android-35/android.jar"
HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.environ.get("COO_APK_SRC", HERE + "/src")
OUT = BASE + "/out"

STOREPASS = "coo-console-local"
FINAL_NAME = "CooConsole-2.5.apk"

env = os.environ.copy()
env["JAVA_HOME"] = JDK
env["PATH"] = JDK + "/bin" + os.pathsep + env.get("PATH", "")


def run(args, label):
    print("\n>>> " + label, flush=True)
    print("    " + " ".join(str(a) for a in args), flush=True)
    p = subprocess.run(args, env=env, text=True, errors="replace",
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    out = (p.stdout or "").strip()
    if out:
        print(out[:4000], flush=True)
    if p.returncode != 0:
        raise SystemExit("FAILED: " + label)
    return out


def main():
    # aapt2 on Windows cannot read non-ASCII paths: stage sources under BASE.
    work_src = BASE + "/src"
    if os.path.abspath(SRC) != os.path.abspath(work_src):
        if os.path.isdir(work_src):
            shutil.rmtree(work_src)
        shutil.copytree(SRC, work_src)
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT + "/classes")
    os.makedirs(OUT + "/dex")

    # 1. compile resources into a flat archive
    run([AAPT2, "compile", "--dir", work_src + "/res", "-o", OUT + "/res.zip"],
        "aapt2 compile")

    # 2. link resources + manifest into an unsigned APK skeleton
    run([AAPT2, "link",
         "-o", OUT + "/base.apk",
         "-I", ANDROID_JAR,
         "--manifest", work_src + "/AndroidManifest.xml",
         "-R", OUT + "/res.zip",
         "--auto-add-overlay",
         "--min-sdk-version", "24",
         "--target-sdk-version", "34"],
        "aapt2 link")

    # 3. compile every Java source against android.jar (Java 8 bytecode for d8)
    java_sources = sorted(glob.glob(work_src + "/java/coo/console/*.java"))
    if not java_sources:
        raise SystemExit("FAILED: no Java sources found")
    print("    sources: " + ", ".join(os.path.basename(p) for p in java_sources))
    run([JAVAC, "-encoding", "UTF-8", "-source", "8", "-target", "8",
         "-bootclasspath", ANDROID_JAR,
         "-classpath", ANDROID_JAR,
         "-d", OUT + "/classes"] + java_sources,
        "javac")

    class_files = []
    for root, _, files in os.walk(OUT + "/classes"):
        for f in files:
            if f.endswith(".class"):
                class_files.append(os.path.join(root, f))
    print("    classes: " + str(len(class_files)), flush=True)

    # 4. dex (use the jar entry point so we do not depend on .bat / cmd)
    run([JAVA, "-cp", D8_JAR, "com.android.tools.r8.D8",
         "--lib", ANDROID_JAR,
         "--min-api", "24",
         "--output", OUT + "/dex"] + class_files,
        "d8")

    dex_path = OUT + "/dex/classes.dex"
    if not os.path.isfile(dex_path):
        raise SystemExit("FAILED: classes.dex not produced")

    # 5. append classes.dex to the APK skeleton
    with zipfile.ZipFile(OUT + "/base.apk", "a", zipfile.ZIP_DEFLATED) as z:
        z.write(dex_path, "classes.dex")
    print("\n>>> attached classes.dex (%d bytes)" % os.path.getsize(dex_path), flush=True)

    # 6. align
    run([ZIPALIGN, "-f", "-p", "4", OUT + "/base.apk", OUT + "/aligned.apk"],
        "zipalign")

    # 7. self-signed release keystore (created once, reused on rebuilds)
    keystore = BASE + "/coo-console.jks"
    if not os.path.isfile(keystore):
        run([KEYTOOL, "-genkeypair", "-alias", "coo", "-keyalg", "RSA",
             "-keysize", "2048", "-validity", "10000",
             "-keystore", keystore,
             "-storepass", STOREPASS, "-keypass", STOREPASS,
             "-dname", "CN=Coo Console, O=Coo, C=CN"],
            "keytool")

    # 8. sign (v1 + v2 + v3)
    signed = OUT + "/signed.apk"
    run([JAVA, "-jar", APKSIGNER_JAR, "sign",
         "--ks", keystore,
         "--ks-pass", "pass:" + STOREPASS,
         "--key-pass", "pass:" + STOREPASS,
         "--v1-signing-enabled", "true",
         "--v2-signing-enabled", "true",
         "--v3-signing-enabled", "true",
         "--out", signed,
         OUT + "/aligned.apk"],
        "apksigner sign")

    # 9. verify
    run([JAVA, "-jar", APKSIGNER_JAR, "verify", "--verbose", signed],
        "apksigner verify")
    run([AAPT2, "dump", "badging", signed], "aapt2 badging")

    # 10. deliver
    deliver = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(HERE), FINAL_NAME)
    shutil.copyfile(signed, deliver)
    print("\nOK -> %s (%d bytes)" % (deliver, os.path.getsize(deliver)), flush=True)


if __name__ == "__main__":
    main()
