export const GET_PRODUCTS = `
  query getProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      edges {
        node {
          id
          title
          descriptionHtml
          productType
          vendor
          tags
          seo {
            title
            description
          }
          metafields(first: 20) {
            edges {
              node {
                id
                key
                namespace
                value
                type
              }
            }
          }
          variants(first: 10) {
            edges {
              node {
                id
                title
                price
                availableForSale
                sku
              }
            }
          }
          images(first: 5) {
            edges {
              node {
                url
                altText
              }
            }
          }
          onlineStoreUrl
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`

export const GET_PRODUCT = `
  query getProduct($id: ID!) {
    product(id: $id) {
      id
      title
      descriptionHtml
      productType
      vendor
      tags
      seo {
        title
        description
      }
      metafields(first: 20) {
        edges {
          node {
            id
            key
            namespace
            value
            type
          }
        }
      }
      variants(first: 10) {
        edges {
          node {
            id
            title
            price
            availableForSale
            sku
          }
        }
      }
      images(first: 5) {
        edges {
          node {
            url
            altText
          }
        }
      }
      onlineStoreUrl
    }
  }
`

export const STOREFRONT_GET_PRODUCTS = `
  query storefrontProducts($first: Int!) {
    products(first: $first) {
      edges {
        node {
          id
          handle
          title
          description
          productType
          vendor
          tags
          onlineStoreUrl
        }
      }
    }
  }
`
