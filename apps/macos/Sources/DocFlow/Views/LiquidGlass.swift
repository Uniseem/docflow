import SwiftUI

// Liquid Glass, the design system macOS 26 introduced, with the previous
// look kept as a fallback.
//
// The old design painted chrome with flat translucent materials
// (NSVisualEffectView, `.regularMaterial`), a hairline border and a drawn
// shadow. Liquid Glass instead floats a lens over the content: it refracts
// and reflects what is behind it, carries its own specular edge, and needs
// no border or shadow of its own. Two rules shape the code below:
//
//   * Glass belongs to the navigation layer — toolbars, bars, floating
//     controls — never to the content underneath, and never on top of other
//     glass.
//   * Shapes are capsules or concentric rounded rectangles, so a control
//     stays concentric with whatever contains it.
//
// The system components this app uses (window toolbar, sidebar, sheets,
// popovers, segmented controls, search field) adopt Liquid Glass on their
// own as soon as the app is built against the macOS 26 SDK. The helpers here
// cover the chrome DocFlow draws itself and fall back to the macOS 14 look,
// so the views stay free of availability checks. Toolbar content is the one
// exception: `ToolbarSpacer`, which splits a toolbar into separate glass
// groups, has to be guarded where it is used, because a builder that is
// empty before macOS 26 does not compile.
//
// `#if compiler(>=6.2)` — Swift 6.2 ships with the macOS 26 SDK in Xcode 26
// — lets the package still build with Xcode 16, whose SDK has none of these
// symbols; that build simply gets the fallbacks everywhere.

extension View {
    /// Chrome floating over content: the toast, a bar, a badge. `shape`
    /// should be a capsule or a concentric rounded rectangle.
    func glassChrome(in shape: some InsettableShape) -> some View {
        modifier(GlassChrome(shape: shape))
    }

    /// A secondary action in the navigation layer (a sheet's bottom bar, an
    /// overlay): bordered glass on macOS 26.
    func glassAction() -> some View {
        modifier(GlassAction(prominent: false))
    }

    /// The default action of a sheet or an empty state: filled glass in the
    /// accent colour on macOS 26.
    func prominentGlassAction() -> some View {
        modifier(GlassAction(prominent: true))
    }

    /// Lets scrolled content dissolve into the glass above or below it
    /// instead of ending at a hairline divider.
    func softScrollEdges(_ edges: Edge.Set = .all) -> some View {
        modifier(SoftScrollEdges(edges: edges))
    }

    /// A bar pinned to one edge of a scrollable view: glass, and part of the
    /// safe area, so the content scrolls behind it.
    func glassBar<Bar: View>(
        edge: VerticalEdge,
        alignment: HorizontalAlignment = .center,
        @ViewBuilder content: @escaping () -> Bar
    ) -> some View {
        modifier(GlassBar(edge: edge, alignment: alignment, bar: content))
    }
}

/// Groups nearby glass so the shapes sense each other and blend while they
/// move or resize. Glass outside a container never merges.
struct GlassGroup<Content: View>: View {
    var spacing: CGFloat?
    @ViewBuilder var content: Content

    init(spacing: CGFloat? = nil, @ViewBuilder content: () -> Content) {
        self.spacing = spacing
        self.content = content()
    }

    var body: some View {
        #if compiler(>=6.2)
        if #available(macOS 26.0, *) {
            GlassEffectContainer(spacing: spacing) {
                content
            }
        } else {
            content
        }
        #else
        content
        #endif
    }
}

/// The outline of a drop target. On macOS 26 its corners are concentric
/// with the container's, and the fill is a tint rather than glass: the list
/// under it has to stay readable while the files hover.
struct DropTargetOutline: View {
    var cornerRadius: CGFloat
    var inset: CGFloat

    init(cornerRadius: CGFloat = 10, inset: CGFloat = 4) {
        self.cornerRadius = cornerRadius
        self.inset = inset
    }

    var body: some View {
        outline
            .padding(inset)
            .allowsHitTesting(false)
    }

    @ViewBuilder
    private var outline: some View {
        #if compiler(>=6.2)
        if #available(macOS 26.0, *) {
            let shape = ConcentricRectangle(corners: .concentric(minimum: .fixed(cornerRadius)), isUniform: true)
            shape
                .fill(Color.accentColor.opacity(0.08))
                .overlay { shape.stroke(Color.accentColor, lineWidth: 3) }
        } else {
            legacy
        }
        #else
        legacy
        #endif
    }

    private var legacy: some View {
        RoundedRectangle(cornerRadius: cornerRadius)
            .strokeBorder(Color.accentColor, lineWidth: 3)
    }
}

private struct GlassChrome<S: InsettableShape>: ViewModifier {
    let shape: S

    @ViewBuilder
    func body(content: Content) -> some View {
        #if compiler(>=6.2)
        if #available(macOS 26.0, *) {
            content.glassEffect(.regular, in: shape)
        } else {
            legacy(content)
        }
        #else
        legacy(content)
        #endif
    }

    /// The macOS 14 look: a flat material, a hairline border and a shadow.
    private func legacy(_ content: Content) -> some View {
        content
            .background(.regularMaterial, in: shape)
            .overlay {
                shape.strokeBorder(Color.primary.opacity(0.12))
            }
            .shadow(color: .black.opacity(0.18), radius: 10, y: 3)
    }
}

private struct GlassAction: ViewModifier {
    let prominent: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        #if compiler(>=6.2)
        if #available(macOS 26.0, *) {
            if prominent {
                content.buttonStyle(.glassProminent)
            } else {
                content.buttonStyle(.glass)
            }
        } else {
            legacy(content)
        }
        #else
        legacy(content)
        #endif
    }

    @ViewBuilder
    private func legacy(_ content: Content) -> some View {
        if prominent {
            content.buttonStyle(.borderedProminent)
        } else {
            content.buttonStyle(.bordered)
        }
    }
}

private struct SoftScrollEdges: ViewModifier {
    let edges: Edge.Set

    @ViewBuilder
    func body(content: Content) -> some View {
        #if compiler(>=6.2)
        if #available(macOS 26.0, *) {
            content.scrollEdgeEffectStyle(.soft, for: edges)
        } else {
            content
        }
        #else
        content
        #endif
    }
}

private struct GlassBar<Bar: View>: ViewModifier {
    let edge: VerticalEdge
    let alignment: HorizontalAlignment
    @ViewBuilder let bar: () -> Bar

    @ViewBuilder
    func body(content: Content) -> some View {
        #if compiler(>=6.2)
        if #available(macOS 26.0, *) {
            content.safeAreaBar(edge: edge, alignment: alignment, content: bar)
        } else {
            content.safeAreaInset(edge: edge, alignment: alignment, content: bar)
        }
        #else
        content.safeAreaInset(edge: edge, alignment: alignment, content: bar)
        #endif
    }
}
