import { types as t } from "@marko/babel-types";
import { findParentTag, assertNoArgs, getTagDef } from "@marko/babel-utils";
import { getAttrs } from "./util";

const EMPTY_OBJECT = {};
const parentIdentifierLookup = new WeakMap();

// TODO: optimize inline repeated @tags.

export default function(path) {
  const { node } = path;
  const namePath = path.get("name");
  const tagName = namePath.node.value;
  const parentPath = findParentTag(path);

  assertNoArgs(path);

  if (!parentPath) {
    throw namePath.buildCodeFrameError(
      "@tags must be nested within another element."
    );
  }

  const parentAttributes = parentPath.get("attributes");
  const tagDef = getTagDef(path);
  const { isRepeated, targetProperty = tagName.slice(1) } =
    tagDef || EMPTY_OBJECT;
  const isDynamic = isRepeated || parentPath !== path.parentPath.parentPath;
  parentPath.node.exampleAttributeTag = node;
  parentPath.node.hasDynamicAttributeTags =
    isDynamic || node.hasDynamicAttributeTags;

  if (!isDynamic) {
    if (
      parentAttributes.some(attr => attr.get("name").node === targetProperty)
    ) {
      throw namePath.buildCodeFrameError(
        `Only one "${tagName}" tag is allowed here.`
      );
    }

    let attrs = getAttrs(path);

    if (t.isNullLiteral(attrs)) {
      // TODO: this could be left as a null literal, but would require changes in the
      // await tag runtime to handle `<@catch/>`. (this would be a breaking change though)
      attrs = t.objectExpression([]);
    }

    parentPath.pushContainer(
      "attributes",
      t.markoAttribute(targetProperty, attrs)
    );

    path.remove();
    return;
  }

  let identifier = parentIdentifierLookup.get(parentPath);

  if (!identifier) {
    identifier = path.scope.generateUidIdentifier(targetProperty);
    parentIdentifierLookup.set(parentPath, identifier);
    parentPath
      .get("body")
      .unshiftContainer(
        "body",
        t.variableDeclaration(isRepeated ? "const" : "let", [
          t.variableDeclarator(
            identifier,
            isRepeated ? t.arrayExpression([]) : t.nullLiteral()
          )
        ])
      );
    parentPath.pushContainer(
      "attributes",
      t.markoAttribute(targetProperty, identifier)
    );
  }

  if (isRepeated) {
    path.replaceWith(
      t.expressionStatement(
        t.callExpression(t.memberExpression(identifier, t.identifier("push")), [
          getAttrs(path)
        ])
      )
    );
  } else {
    path.replaceWith(
      t.expressionStatement(
        t.assignmentExpression("=", identifier, getAttrs(path))
      )
    );
  }
}