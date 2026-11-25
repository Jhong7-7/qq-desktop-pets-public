import javax.imageio.ImageIO;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.geom.Ellipse2D;
import java.awt.image.BufferedImage;
import java.io.File;

public class MakeIcons {
    public static void main(String[] args) throws Exception {
        BufferedImage src = ImageIO.read(new File(args[0]));
        File res = new File(args[1]);
        String[] names = {"mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"};
        double[] factors = {1.0, 1.5, 2.0, 3.0, 4.0};

        for (int i = 0; i < names.length; i++) {
            File dir = new File(res, "mipmap-" + names[i]);
            dir.mkdirs();
            int launcher = (int) (48 * factors[i]);
            int fgSize = (int) (108 * factors[i]);

            save(scale(src, launcher, false), new File(dir, "ic_launcher.png"));
            save(scale(src, launcher, true), new File(dir, "ic_launcher_round.png"));

            BufferedImage fg = new BufferedImage(fgSize, fgSize, BufferedImage.TYPE_INT_ARGB);
            Graphics2D g = fg.createGraphics();
            hints(g);
            int inner = (int) (fgSize * 0.66);
            int off = (fgSize - inner) / 2;
            g.drawImage(src, off, off, inner, inner, null);
            g.dispose();
            save(fg, new File(dir, "ic_launcher_foreground.png"));

            System.out.println(names[i] + ": launcher=" + launcher + " foreground=" + fgSize);
        }
    }

    private static BufferedImage scale(BufferedImage src, int size, boolean round) {
        BufferedImage out = new BufferedImage(size, size, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = out.createGraphics();
        hints(g);
        if (round) {
            g.setClip(new Ellipse2D.Float(0, 0, size, size));
        }
        g.drawImage(src, 0, 0, size, size, null);
        g.dispose();
        return out;
    }

    private static void hints(Graphics2D g) {
        g.setRenderingHint(RenderingHints.KEY_INTERPOLATION,
                RenderingHints.VALUE_INTERPOLATION_BICUBIC);
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING,
                RenderingHints.VALUE_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_RENDERING,
                RenderingHints.VALUE_RENDER_QUALITY);
    }

    private static void save(BufferedImage img, File f) throws Exception {
        ImageIO.write(img, "png", f);
    }
}
